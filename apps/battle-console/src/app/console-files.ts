import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import type { ScenarioBundleFile } from '@scene-director/battle';

/**
 * The file extension read as a zip: its entries become the bundle's files.
 */
export const CONSOLE_ZIP_EXTENSION = '.zip';

/**
 * What the Load button and the drop area accept: a zip, JSON parts and EFT fits (folders come through the window drop).
 */
export const CONSOLE_DROP_ACCEPT = ['.zip', '.json', '.eft', '.txt'];

/**
 * A dropped file and the path it had in its folder (a folder drop's relative path, else the file's name).
 */
export interface ConsoleDroppedFile {
  readonly path: string;
  readonly file: File;
}

/**
 * Reads dropped files into the bundle's text files: a zip's entries (read with zip.js, no web workers), every other
 * file as text. The bundle reader skips what it does not know.
 *
 * @param files - The dropped files.
 * @returns The bundle's files, a zip's under the zip's own path.
 */
export async function readConsoleFiles(files: readonly ConsoleDroppedFile[]): Promise<ScenarioBundleFile[]> {
  const read: ScenarioBundleFile[] = [];

  for (const { path, file } of files) {
    if (path.toLowerCase().endsWith(CONSOLE_ZIP_EXTENSION)) {
      read.push(...(await readConsoleZip(file)));
    } else {
      read.push({ path, text: await file.text() });
    }
  }

  return read;
}

/**
 * Reads a zip's file entries as text.
 *
 * @param zip - The zip.
 * @returns Its files, by their path in the zip.
 */
export async function readConsoleZip(zip: Blob): Promise<ScenarioBundleFile[]> {
  const reader = new ZipReader(new BlobReader(zip), { useWebWorkers: false });
  const read: ScenarioBundleFile[] = [];

  try {
    for (const entry of await reader.getEntries()) {
      if (!entry.directory) {
        read.push({ path: entry.filename, text: await entry.getData(new TextWriter()) });
      }
    }
  } finally {
    await reader.close();
  }

  return read;
}

/**
 * The files of a drop's DataTransfer, folders walked (webkitGetAsEntry), each with its path in the drop.
 *
 * @param transfer - The drop event's DataTransfer.
 * @returns The dropped files.
 */
export async function droppedConsoleFiles(transfer: DataTransfer): Promise<ConsoleDroppedFile[]> {
  const entries = Array.from(transfer.items)
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry != null);
  let result: ConsoleDroppedFile[];

  if (entries.length > 0) {
    const nested = await Promise.all(entries.map((entry) => walkConsoleEntry(entry)));
    result = nested.flat();
  } else {
    result = Array.from(transfer.files).map((file) => ({ path: file.name, file }));
  }

  return result;
}

/**
 * Plain files picked through an input (the Load button): each by its name, or a folder pick's relative path.
 *
 * @param files - The picked files.
 * @returns The dropped files.
 */
export function pickedConsoleFiles(files: readonly File[]): ConsoleDroppedFile[] {
  return files.map((file) => ({ path: file.webkitRelativePath || file.name, file }));
}

async function walkConsoleEntry(entry: FileSystemEntry): Promise<ConsoleDroppedFile[]> {
  let result: ConsoleDroppedFile[] = [];

  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    result = [{ path: entry.fullPath.replace(/^\//, ''), file }];
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    let batch: FileSystemEntry[];

    // readEntries returns at most 100 entries per call; an empty batch ends the folder
    do {
      batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      children.push(...batch);
    } while (batch.length > 0);

    const nested = await Promise.all(children.map((child) => walkConsoleEntry(child)));
    result = nested.flat();
  }

  return result;
}
