/**
 * A trimmed fixture of one rock DNA's SOF values, captured from tools-core
 * (`/eve/3646012/sof/dna/rock_01_m_v1a_whiteyellow:ore_veldspar:asteroid`, 2026-10-23): the root and mesh fields the
 * field composer reads, one texture per area, and the controllers, locators and impact overlay it drops. No vitest
 * import, so the app tsconfig may include it.
 */

export const ROCK_DNA = 'rock_01_m_v1a_whiteyellow:ore_veldspar:asteroid';

export const ROCK_VALUES: Record<string, unknown> = {
  _type: 'EveStation2',
  boundingSphereCenter: [-0.010358800180256367, -0.119336798787117, 0.03992379829287529],
  boundingSphereRadius: 0.8821905851364136,
  castShadow: true,
  reflectionMode: 3,
  mesh: {
    _type: 'Tr2Mesh',
    geometryResPath: 'res:/dx9/model/celestial/asteroid/rock_01/medium/rock_01_m_v1.gr2',
    opaqueAreas: [
      {
        _type: 'Tr2MeshArea',
        name: 'area_rock',
        index: 1,
        count: 1,
        reversed: false,
        castsShadows: true,
        effect: {
          _type: 'Tr2Effect',
          name: 'area_rock',
          effectFilePath: 'res:/graphics/effect/managed/space/spaceobject/v5/quad/quadenvironmentv5.fx',
          options: [
            {
              _type: 'Tr2ShaderOption',
              name: 'SPACE_OBJECT_TRANSPARENCY',
              value: 'SOT_OPAQUE'
            },
            {
              _type: 'Tr2ShaderOption',
              name: 'SPACE_OBJECT_PPT_ENABLED',
              value: 'SOPPT_DISABLED'
            }
          ],
          resources: [
            {
              _type: 'TriTextureParameter',
              name: 'AlbedoMap',
              resourcePath: 'res:/dx9/model/shared/environment/rock/rock_surface_01/rock_surface_2k_01_a.dds'
            }
          ]
        }
      },
      {
        _type: 'Tr2MeshArea',
        name: 'area_ore',
        index: 0,
        count: 1,
        reversed: false,
        castsShadows: true,
        effect: {
          _type: 'Tr2Effect',
          name: 'area_ore',
          effectFilePath: 'res:/graphics/effect/managed/space/spaceobject/v5/quad/quadenvironmentv5.fx',
          options: [
            {
              _type: 'Tr2ShaderOption',
              name: 'SPACE_OBJECT_TRANSPARENCY',
              value: 'SOT_OPAQUE'
            },
            {
              _type: 'Tr2ShaderOption',
              name: 'SPACE_OBJECT_PPT_ENABLED',
              value: 'SOPPT_DISABLED'
            }
          ],
          resources: [
            {
              _type: 'TriTextureParameter',
              name: 'AlbedoMap',
              resourcePath: 'res:/dx9/model/shared/environment/rock/rock_surface_01/rock_surface_2k_01_a.dds'
            }
          ]
        }
      }
    ],
    transparentAreas: [],
    additiveAreas: [],
    distortionAreas: [],
    depthAreas: []
  },
  controllers: [
    {
      _type: 'Tr2ControllerReference'
    },
    {
      _type: 'Tr2ControllerReference'
    }
  ],
  locators: [
    {
      _type: 'EveLocator2',
      name: 'locator_audio_booster'
    }
  ],
  locatorSets: [
    {
      _type: 'EveLocatorSets',
      name: 'damage',
      locators: []
    }
  ],
  impactOverlay: {},
  inheritProperties: {
    _type: 'EveChildInheritProperties',
    Primary: [0.21652530133724213, 0.34025219082832336, 0.5284010767936707, 0],
    Secondary: [0.5882353186607361, 0.19215689599514008, 0.10588239878416061, 1],
    Tertiary: [0.26274511218070984, 0.6039215922355652, 0.43137261271476746, 1],
    Black: [0, 0, 0, 1],
    White: [0.36862748861312866, 0.3529411852359772, 0.3215686082839966, 1],
    Yellow: [0.8784313797950745, 0.6588234901428223, 0.19215689599514008, 1],
    Orange: [0.5254902243614197, 0.2588235139846802, 0, 1],
    Red: [0.32549020648002625, 0.035294100642204285, 0, 1],
    Blue: [0.14900000393390656, 0.2353000044822693, 0.3528999984264374, 1],
    Green: [0.29019609093666077, 0.4901961088180542, 0.11372549831867218, 1],
    Cyan: [0.2666667103767395, 0.5450981259346008, 0.4627451002597809, 1],
    Fire: [3.433739423751831, 1.1356091499328613, 0, 1],
    Hull: [0.18431369960308075, 0.1568627953529358, 0.050980400294065475, 1],
    Glass: [2.9705519676208496, 3.9248225688934326, 2.9705519676208496, 1],
    Reactor: [1.5686274766921997, 3.372549057006836, 4.960784435272217, 1],
    Darkhull: [4.913621425628662, 3.884079933166504, 2.4003124237060547, 1],
    Booster: [1.5686274766921997, 3.372549057006836, 4.960784435272217, 1],
    Killmark: [1, 0, 1, 1],
    PrimaryLight: [0.21652530133724213, 0.34025219082832336, 0.5284010767936707, 0],
    SecondaryLight: [0.5882353186607361, 0.19215689599514008, 0.10588239878416061, 1],
    TertiaryLight: [0.26274511218070984, 0.6039215922355652, 0.43137261271476746, 1],
    WhiteLight: [0.36862748861312866, 0.3529411852359772, 0.3215686082839966, 1],
    PrimaryHologram: [0, 0, 0, 1],
    SecondaryHologram: [0, 0, 0, 1],
    TertiaryHologram: [0, 0, 0, 1],
    State0: [0, 0, 0, 1],
    State1: [0, 0, 0, 1],
    State2: [0, 0, 0, 1],
    State3: [0, 0, 0, 1],
    StateVulnerable: [0, 0, 0, 1],
    StateInvulnerable: [0, 0, 0, 1],
    PrimaryForcefield: [0, 0, 0, 1],
    SecondaryForcefield: [0, 0, 0, 1],
    PrimaryBanner: [0, 0, 0, 1],
    PrimaryFx: [0, 0, 0, 1],
    SecondaryFx: [0, 0, 0, 1],
    PrimarySpotlight: [0, 0, 0, 1],
    SecondarySpotlight: [0, 0, 0, 1],
    TertiarySpotlight: [0, 0, 0, 1],
    PrimaryBillboard: [2.5, 2.5, 2.5, 2.5],
    PrimaryWarpFx: [1, 0.38823529411764707, 0.2, 1],
    PrimaryAttackFx: [1, 0.09411764705882353, 0.043137254901960784, 1],
    PrimarySiegeFx: [1, 0.3686274509803922, 0.17647058823529413, 1],
    PrimaryDockedFx: [0.2980392156862745, 0.5098039215686274, 0.8862745098039215, 1]
  }
};
