#!/usr/bin/env bash
# Sets up (or checks) chrome-devtools-mcp on the Windows side of this WSL2 box; see ../SKILL.md for why.
#
#   setup.sh           install whatever is missing: portable Windows Node, the package, the wrapper, the
#                      user-scope MCP registration; then run the checks
#   setup.sh --update  move to the newest Node LTS and chrome-devtools-mcp (no server may be running)
#   setup.sh --check   report every piece and run an MCP handshake; changes nothing
#
# Exit code: 0 when every check passes, 1 otherwise, 2 for a usage error.
set -euo pipefail

MODE=${1:-install}
case "$MODE" in
  install | --update | --check) ;;
  *)
    echo "usage: $0 [--update | --check]" >&2
    exit 2
    ;;
esac

SERVER_NAME=chrome-devtools
WRAPPER="$HOME/.local/bin/chrome-devtools-mcp-windows"
HUB_URL=http://127.0.0.1:5520/
# A wedged WSL interop hangs Windows executables instead of failing them, so every call gets a deadline.
WIN_TIMEOUT=30

# Runs a Windows executable from a drive path (a \\wsl.localhost working directory upsets cmd.exe).
win() { (cd /mnt/c && timeout "$WIN_TIMEOUT" "$@"); }

if ! WIN_HOME_W=$(win cmd.exe /d /c 'echo %USERPROFILE%' | tr -d '\r') || [ -z "$WIN_HOME_W" ]; then
  echo "FAIL interop: Windows did not answer in ${WIN_TIMEOUT}s. Run 'wsl --shutdown' from Windows, then retry." >&2
  exit 1
fi
DIR="$(wslpath -u "$WIN_HOME_W")/.chrome-devtools-mcp"
NODE_EXE="$DIR/node/node.exe"
PACKAGE_JSON="$DIR/node_modules/chrome-devtools-mcp/package.json"

# Windows processes of the server and the Chrome it launched (the browser process only, not its children).
running_processes() {
  win powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'node.exe' -and \$_.CommandLine -like '*chrome-devtools-mcp*') -or (\$_.Name -eq 'chrome.exe' -and \$_.CommandLine -like '*chrome-devtools-mcp*' -and \$_.CommandLine -notlike '*--type=*') } | ForEach-Object { \$_.Name + ' pid ' + \$_.ProcessId }" | tr -d '\r'
}

install_node() {
  local tmp version zip
  tmp=$(mktemp -d)
  version=$(curl -fsS https://nodejs.org/dist/index.json |
    node -e 'const all = JSON.parse(require("fs").readFileSync(0)); console.log(all.find((r) => r.lts && r.files.includes("win-x64-zip")).version)')
  zip="node-$version-win-x64.zip"
  echo "Node: downloading $version"
  curl -fsSL -o "$tmp/$zip" "https://nodejs.org/dist/$version/$zip"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$version/SHASUMS256.txt"
  (cd "$tmp" && grep " $zip\$" SHASUMS256.txt | sha256sum -c --quiet -)
  mkdir -p "$DIR"
  cp "$tmp/$zip" "$DIR/"
  # Windows' own tar extracts at native speed; unzipping over 9p is slow.
  (cd "$DIR" && timeout 300 tar.exe -xf "$zip")
  rm "$DIR/$zip"
  if [ -d "$DIR/node" ]; then
    mv "$DIR/node" "$DIR/node.old"
    rm -r "$DIR/node.old"
  fi
  mv "$DIR/${zip%.zip}" "$DIR/node"
}

install_package() {
  echo "chrome-devtools-mcp: installing the latest release"
  (cd "$DIR" && timeout 600 ./node/node.exe node/node_modules/npm/bin/npm-cli.js install --prefix . \
    --no-fund --no-audit --no-update-notifier --loglevel=error chrome-devtools-mcp@latest)
}

write_wrapper() {
  mkdir -p "$(dirname "$WRAPPER")"
  cat > "$WRAPPER" << EOF
#!/bin/sh
# chrome-devtools-mcp for WSL2 (NAT networking), run on the Windows side through interop.
# Written by carbon-engine-scene-director/.claude/skills/windows-chrome/scripts/setup.sh; rerun that to change it.
#
# WSL cannot reach Windows' 127.0.0.1 in NAT mode, so the MCP server runs under a portable Windows Node and
# launches/drives Windows Chrome over Windows loopback; MCP stdio passes through interop. Windows Chrome reaches
# WSL servers on 127.0.0.1 through WSL's localhost forwarding. Paths given to its tools are Windows paths.
cd '$DIR' || exit 1
exec ./node/node.exe node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js \\
  --no-usage-statistics --no-performance-crux "\$@"
EOF
  chmod +x "$WRAPPER"
}

registered_command() {
  node -e 'const c = JSON.parse(require("fs").readFileSync(require("os").homedir() + "/.claude.json", "utf8"));
console.log(c.mcpServers?.[process.argv[1]]?.command ?? "")' "$SERVER_NAME" 2> /dev/null || true
}

register() {
  local current
  current=$(registered_command)
  if [ "$current" = "$WRAPPER" ]; then
    return
  fi
  if [ -n "$current" ]; then
    echo "MCP: '$SERVER_NAME' is registered to run '$current'; leaving it. Remove it with: claude mcp remove $SERVER_NAME -s user" >&2
    return
  fi
  claude mcp add --scope user "$SERVER_NAME" -- "$WRAPPER"
}

# Sends initialize through the wrapper and prints the server's name and version.
handshake() {
  node -e '
const { spawn } = require("node:child_process");
const child = spawn(process.argv[1], [], { stdio: ["pipe", "pipe", "ignore"] });
const deadline = setTimeout(() => { console.log("no answer in 60 s"); child.kill(); process.exit(1); }, 60000);
let buffer = "";
child.stdout.on("data", (data) => {
  buffer += data;
  const end = buffer.indexOf("\n");
  if (end < 0) return;
  clearTimeout(deadline);
  let message;
  try { message = JSON.parse(buffer.slice(0, end)); } catch { message = { error: "stdout is not MCP: " + buffer.slice(0, end) }; }
  console.log(message.result ? message.result.serverInfo.name + " " + message.result.serverInfo.version : JSON.stringify(message.error));
  process.exitCode = message.result ? 0 : 1;
  child.stdin.end();
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "setup-check", version: "0" } } }) + "\n");
' "$WRAPPER"
}

failures=0
report() { # report <ok|FAIL|info> <what> <detail>
  printf '%-5s %-22s %s\n' "$1" "$2" "$3"
  if [ "$1" = FAIL ]; then failures=$((failures + 1)); fi
}

check() {
  report ok interop "Windows home $WIN_HOME_W"
  if [ -x "$NODE_EXE" ]; then
    report ok "windows node" "$(cd "$DIR" && timeout "$WIN_TIMEOUT" ./node/node.exe --version | tr -d '\r') in $DIR/node"
  else
    report FAIL "windows node" "missing: $NODE_EXE (run setup.sh)"
  fi
  if [ -f "$PACKAGE_JSON" ]; then
    report ok chrome-devtools-mcp "$(node -p 'require(process.argv[1]).version' "$PACKAGE_JSON")"
  else
    report FAIL chrome-devtools-mcp "missing: $PACKAGE_JSON (run setup.sh)"
  fi
  if [ -x "$WRAPPER" ] && grep -qF "cd '$DIR'" "$WRAPPER"; then
    report ok wrapper "$WRAPPER"
  else
    report FAIL wrapper "missing or not pointing at $DIR: $WRAPPER (run setup.sh)"
  fi
  local current
  current=$(registered_command)
  if [ "$current" = "$WRAPPER" ]; then
    report ok "mcp registration" "'$SERVER_NAME' at user scope"
  else
    report FAIL "mcp registration" "'$SERVER_NAME' runs '${current:-nothing}', expected $WRAPPER"
  fi
  local answer
  if answer=$(handshake); then
    report ok handshake "$answer"
  else
    report FAIL handshake "$answer"
  fi
  if curl -fsS -o /dev/null "$HUB_URL" 2> /dev/null; then
    local code
    code=$(win curl.exe -s -o NUL -w '%{http_code}' "$HUB_URL" | tr -d '\r' || true)
    if [ "$code" = 200 ]; then
      report ok "hub from windows" "$HUB_URL answers Windows (localhost forwarding)"
    else
      report FAIL "hub from windows" "$HUB_URL answers WSL but not Windows (HTTP '${code:-none}'); check localhostForwarding in .wslconfig"
    fi
  else
    report info "hub from windows" "skipped: no hub on $HUB_URL"
  fi
  local processes
  processes=$(running_processes || true)
  processes=${processes//$'\n'/, }
  report info "windows processes" "${processes:-none}"
}

case "$MODE" in
  --check) ;;
  --update)
    if running_processes | grep -q node.exe; then
      echo "A chrome-devtools-mcp server is running and Windows locks its files. Disconnect '$SERVER_NAME' in every" >&2
      echo "Claude session using it (/mcp), then rerun --update." >&2
      exit 1
    fi
    install_node
    install_package
    write_wrapper
    register
    ;;
  install)
    if [ ! -x "$NODE_EXE" ]; then install_node; fi
    if [ ! -f "$PACKAGE_JSON" ]; then install_package; fi
    write_wrapper
    register
    ;;
esac

check
exit $((failures > 0))
