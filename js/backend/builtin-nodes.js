// Library graphs built from Script and Event.
'use strict';
const BUILTIN_NODES = [
  {
    name: 'Bool',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: false,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: '2ac8aee4af50fa3e29732a8b06b431ac',
            interface: {
              inputs: [],
              outputs: [
                {
                  editable: true,
                  id: 'pvlo07',
                  name: 'bool',
                  type: 't:d1714f2eec0f4bcfa0edc8602f7f67c2',
                },
              ],
            },
          },
        ],
        groups: [
          {
            color: null,
            disabled: false,
            folded: false,
            id: '2ac8aee4af50fa3e29732a8b06b431ac',
            members: [],
            name: 'Bool',
            parent: null,
            pinned: false,
            position: {
              height: null,
              width: null,
              x: 0,
              y: 0,
            },
          },
        ],
        port_edges: [],
        records: [],
        source_project: 'lib-79f5e0f21efdddc5a3d6169a90346d81',
        styles: {},
        types: [
          {
            color: '#d666c2',
            control: 'checkbox',
            fields: [],
            id: 'd1714f2eec0f4bcfa0edc8602f7f67c2',
            name: 'bool',
          },
        ],
        version: 3,
        widgets: {},
        positions: {},
      },
      description: '',
      folder: 'Value',
      frame: {
        dx: 0,
        dy: 0,
        height: null,
        width: null,
      },
      grants: [],
      icon: 'toggle',
    },
  },
  {
    name: 'Branch',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: false,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: '027416c36566a4fb887a16416d80937b',
            interface: {
              inputs: [
                {
                  bound: [
                    {
                      node_id: 'record:3da2ba5d8b7e66b3c67547738d4fe77d',
                      port_id: 'in',
                    },
                  ],
                  id: 'pfxrn1',
                  name: 'in',
                  type: 'signal',
                },
                {
                  id: 'ple3wy',
                  name: 'condition',
                  type: 't:d1714f2eec0f4bcfa0edc8602f7f67c2',
                },
              ],
              outputs: [
                {
                  id: 'pci35c',
                  name: 'if_true',
                  type: 'signal',
                },
                {
                  id: 'p2qfw0',
                  name: 'if_false',
                  type: 'signal',
                },
              ],
            },
          },
        ],
        groups: [
          {
            color: null,
            disabled: false,
            folded: false,
            id: '027416c36566a4fb887a16416d80937b',
            members: ['record:3da2ba5d8b7e66b3c67547738d4fe77d'],
            name: 'Branch',
            parent: null,
            pinned: false,
          },
        ],
        port_edges: [],
        records: [
          {
            id: 'record:3da2ba5d8b7e66b3c67547738d4fe77d',
            payload: {
              config: {
                grants: [],
                inputs: [
                  {
                    id: 'in',
                    name: 'in',
                    type: 'signal',
                  },
                  {
                    default:
                      'node.input.condition ? await node.output.if_true.emit() : await node.output.if_false.emit();',
                    id: 'script',
                    name: 'script',
                    type: 't:a42dbde0c1e1090d6adf1640c2dda533',
                  },
                ],
                op: 'script',
                outputs: [
                  {
                    id: 'out',
                    name: 'out',
                    type: 'signal',
                  },
                ],
                title: 'Script',
              },
              kind: 'function',
              label: 'Custom',
              node_type: 'custom',
              status: 'ready',
            },
          },
        ],
        source_project: 'lib-2c6bf4d64f46b66183ab5e342d9e3913',
        styles: {
          'record:3da2ba5d8b7e66b3c67547738d4fe77d': {
            color: null,
            disabled: false,
            folded: false,
            pinned: false,
          },
        },
        types: [
          {
            color: '#669ed6',
            control: 'textarea',
            fields: [],
            id: '64428b9c654c2c2cfcb55742ea899ed8',
            name: 'text',
          },
          {
            alias: 't:64428b9c654c2c2cfcb55742ea899ed8',
            color: '#8a6fd6',
            control: 'code',
            fields: [],
            id: 'a42dbde0c1e1090d6adf1640c2dda533',
            name: 'script',
          },
          {
            color: '#d666c2',
            control: 'checkbox',
            fields: [],
            id: 'd1714f2eec0f4bcfa0edc8602f7f67c2',
            name: 'bool',
          },
        ],
        version: 3,
        widgets: {},
        positions: {
          'record:3da2ba5d8b7e66b3c67547738d4fe77d': {
            height: 195,
            width: 672,
            x: -72,
            y: 0,
          },
        },
      },
      description: '',
      folder: 'Flow',
      frame: {
        dx: -96,
        dy: -72,
        height: 200,
        width: 300,
      },
      grants: [],
      icon: 'branch',
    },
  },
  {
    name: 'Break',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: false,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: '84d10ac58626a1482a8bd601e3b4614a',
            interface: {
              inputs: [
                {
                  bound: [
                    {
                      node_id: 'record:dacd35f6cdbff5863aadb46b38bcdd07',
                      port_id: 'in',
                    },
                  ],
                  id: 'in',
                  name: 'in',
                  type: 'signal',
                },
              ],
              outputs: [],
            },
          },
        ],
        groups: [
          {
            color: null,
            folded: false,
            id: '84d10ac58626a1482a8bd601e3b4614a',
            members: ['record:dacd35f6cdbff5863aadb46b38bcdd07'],
            name: 'Break',
            parent: null,
            pinned: false,
          },
        ],
        port_edges: [],
        records: [
          {
            id: 'record:dacd35f6cdbff5863aadb46b38bcdd07',
            payload: {
              config: {
                grants: [],
                inputs: [
                  {
                    id: 'in',
                    name: 'in',
                    type: 'signal',
                  },
                  {
                    default: 'node.flow.break();',
                    id: 'script',
                    name: 'script',
                    type: 't:a42dbde0c1e1090d6adf1640c2dda533',
                  },
                ],
                op: 'script',
                outputs: [
                  {
                    id: 'out',
                    name: 'out',
                    type: 'signal',
                  },
                ],
                title: 'Script',
              },
              kind: 'function',
              label: 'Custom',
              node_type: 'custom',
              status: 'ready',
            },
          },
        ],
        source_project: 'lib-e4c38d6d45baf080943d323dd51a2ce8',
        styles: {
          'record:dacd35f6cdbff5863aadb46b38bcdd07': {
            color: null,
            folded: false,
            pinned: false,
          },
        },
        types: [
          {
            color: '#669ed6',
            control: 'textarea',
            fields: [],
            id: '64428b9c654c2c2cfcb55742ea899ed8',
            name: 'text',
          },
          {
            alias: 't:64428b9c654c2c2cfcb55742ea899ed8',
            color: '#8a6fd6',
            control: 'code',
            fields: [],
            id: 'a42dbde0c1e1090d6adf1640c2dda533',
            name: 'script',
          },
        ],
        version: 3,
        widgets: {},
        positions: {
          'record:dacd35f6cdbff5863aadb46b38bcdd07': {
            x: 0,
            y: 24,
          },
        },
      },
      description:
        'Ends the loop that is running this pass: what the pass has not started does not start, and the loop fires `done`. Put it in the body of For, For each or While.',
      folder: 'Flow',
      frame: {
        dx: 0,
        dy: 0,
        height: 200,
        width: 300,
      },
      grants: [],
      icon: 'exit',
    },
  },
  {
    name: 'Continue',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: false,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: 'efa3c7a4794503e2382065611e596849',
            interface: {
              inputs: [
                {
                  bound: [
                    {
                      node_id: 'record:d1171f869734b48a87d77629138a0551',
                      port_id: 'in',
                    },
                  ],
                  id: 'in',
                  name: 'in',
                  type: 'signal',
                },
              ],
              outputs: [],
            },
          },
        ],
        groups: [
          {
            color: null,
            folded: false,
            id: 'efa3c7a4794503e2382065611e596849',
            members: ['record:d1171f869734b48a87d77629138a0551'],
            name: 'Continue',
            parent: null,
            pinned: false,
          },
        ],
        port_edges: [],
        records: [
          {
            id: 'record:d1171f869734b48a87d77629138a0551',
            payload: {
              config: {
                grants: [],
                inputs: [
                  {
                    id: 'in',
                    name: 'in',
                    type: 'signal',
                  },
                  {
                    default: 'node.flow.continue();',
                    id: 'script',
                    name: 'script',
                    type: 't:a42dbde0c1e1090d6adf1640c2dda533',
                  },
                ],
                op: 'script',
                outputs: [
                  {
                    id: 'out',
                    name: 'out',
                    type: 'signal',
                  },
                ],
                title: 'Script',
              },
              kind: 'function',
              label: 'Custom',
              node_type: 'custom',
              status: 'ready',
            },
          },
        ],
        source_project: 'lib-a0bfb8e59e6c13fc8d990781f77694fe',
        styles: {
          'record:d1171f869734b48a87d77629138a0551': {
            color: null,
            folded: false,
            pinned: false,
          },
        },
        types: [
          {
            color: '#669ed6',
            control: 'textarea',
            fields: [],
            id: '64428b9c654c2c2cfcb55742ea899ed8',
            name: 'text',
          },
          {
            alias: 't:64428b9c654c2c2cfcb55742ea899ed8',
            color: '#8a6fd6',
            control: 'code',
            fields: [],
            id: 'a42dbde0c1e1090d6adf1640c2dda533',
            name: 'script',
          },
        ],
        version: 3,
        widgets: {},
        positions: {
          'record:d1171f869734b48a87d77629138a0551': {
            x: 0,
            y: 24,
          },
        },
      },
      description:
        'Ends this pass of the loop that is running it, and the loop goes on with the next pass. A pass also ends where its signal path ends, so Continue is only needed to stop other branches of the pass.',
      folder: 'Flow',
      frame: {
        dx: 0,
        dy: 0,
        height: 200,
        width: 300,
      },
      grants: [],
      icon: 'skip',
    },
  },
  {
    name: 'Delay',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: false,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: '022962b71c5b9c2f7f573123a6a52a89',
            interface: {
              inputs: [
                {
                  bound: [
                    {
                      node_id: 'record:e1dfb60c60cc68149d5e40a7fb4fccb2',
                      port_id: 'in',
                    },
                  ],
                  id: 'in',
                  name: 'in',
                  type: 'signal',
                },
                {
                  id: 'mode',
                  name: 'mode',
                  type: 't:c10c0000000000000000000000000001',
                  default: 'duration',
                },
                {
                  default: 1000,
                  id: 'ms',
                  name: 'ms',
                  type: 't:fbe54fdd1dd24d55a0ec083cc057017e',
                },
                {
                  default: '',
                  id: 'until',
                  name: 'until',
                  type: 't:64428b9c654c2c2cfcb55742ea899ed8',
                },
              ],
              outputs: [
                {
                  id: 'Out',
                  name: 'out',
                  type: 'signal',
                  bound: [
                    {
                      node_id: 'record:e1dfb60c60cc68149d5e40a7fb4fccb2',
                      port_id: 'out',
                    },
                  ],
                },
                {
                  id: 'result',
                  name: 'result',
                },
              ],
            },
          },
        ],
        groups: [
          {
            color: null,
            disabled: false,
            folded: false,
            id: '022962b71c5b9c2f7f573123a6a52a89',
            members: ['record:e1dfb60c60cc68149d5e40a7fb4fccb2'],
            name: 'Delay',
            parent: null,
            pinned: false,
          },
        ],
        port_edges: [],
        records: [
          {
            id: 'record:e1dfb60c60cc68149d5e40a7fb4fccb2',
            payload: {
              config: {
                grants: [],
                inputs: [
                  {
                    id: 'in',
                    name: 'in',
                    type: 'signal',
                  },
                  {
                    default:
                      'const ms=node.input.mode==="until"?Date.parse(node.input.until)-Date.now():node.input.ms;if(!Number.isFinite(ms))throw Error("Invalid delay");await node.sleep(Math.max(0,ms));node.output.result=null;',
                    id: 'script',
                    name: 'script',
                    type: 't:c0de0c0de0c0de0c0de0c0de0c0de0c0',
                  },
                ],
                op: 'script',
                outputs: [
                  {
                    id: 'out',
                    name: 'out',
                    type: 'signal',
                  },
                ],
                title: 'Script',
              },
              kind: 'function',
              label: 'Custom',
              node_type: 'custom',
              status: 'ready',
            },
          },
        ],
        source_project: 'lib-6e60b1bfff574883aee79ea7ffb8bafa',
        styles: {
          'record:e1dfb60c60cc68149d5e40a7fb4fccb2': {
            color: null,
            disabled: false,
            folded: false,
            pinned: false,
          },
        },
        types: [
          {
            color: '#8a6fd6',
            control: 'code',
            fields: [],
            id: 'c0de0c0de0c0de0c0de0c0de0c0de0c0',
            name: 'code',
          },
          {
            color: '#b3d666',
            control: 'number',
            fields: [],
            id: 'fbe54fdd1dd24d55a0ec083cc057017e',
            name: 'number',
          },
          {
            color: '#669ed6',
            control: 'textarea',
            fields: [],
            id: '64428b9c654c2c2cfcb55742ea899ed8',
            name: 'text',
          },
          {
            id: 'c10c0000000000000000000000000001',
            name: 'delay mode',
            color: '#669ed6',
            fields: [],
            control: 'select',
            options: ['duration', 'until'],
          },
        ],
        version: 3,
        widgets: {},
        positions: {
          'record:e1dfb60c60cc68149d5e40a7fb4fccb2': {
            height: 195,
            width: 504,
            x: 0,
            y: 0,
          },
        },
      },
      description: 'Wait for a duration or until a date, then continue.',
      frame: {
        dx: -128,
        dy: -44,
        height: 259,
        width: 760,
      },
      grants: [],
      folder: 'Flow',
      icon: 'timer',
    },
  },
  {
    name: 'Execute',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: true,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: 'c81741a745addb87055af0679ee76667',
            interface: {
              inputs: [
                {
                  bound: [
                    {
                      node_id: 'record:3ff1df0edb71bd65638eaa07344ef711',
                      port_id: 'in',
                    },
                  ],
                  id: 'p7jbjn',
                  name: 'in',
                  type: 'signal',
                },
                {
                  id: 'pr97li',
                  name: 'script',
                  type: 't:a42dbde0c1e1090d6adf1640c2dda533',
                },
              ],
              outputs: [
                {
                  id: 'pwf67a',
                  name: 'out',
                  type: 'signal',
                  bound: [
                    {
                      node_id: 'record:3ff1df0edb71bd65638eaa07344ef711',
                      port_id: 'out',
                    },
                  ],
                },
                {
                  id: 'pxltyf',
                  name: 'result',
                },
              ],
            },
          },
        ],
        groups: [
          {
            color: null,
            disabled: false,
            folded: false,
            id: 'c81741a745addb87055af0679ee76667',
            members: ['record:3ff1df0edb71bd65638eaa07344ef711'],
            name: 'Execute',
            parent: null,
            pinned: false,
          },
        ],
        port_edges: [],
        records: [
          {
            id: 'record:3ff1df0edb71bd65638eaa07344ef711',
            payload: {
              config: {
                grants: [],
                inputs: [
                  {
                    id: 'in',
                    name: 'in',
                    type: 'signal',
                  },
                  {
                    default:
                      "const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;\nconst run = new AsyncFunction('node', 'agentsys', 'context', 'Date', 'Math', '\"use strict\";\\n' + (node.input.script ?? ''));\nnode.output.result = await run(node, agentsys, context, Date, Math);",
                    id: 'script',
                    name: 'script',
                    type: 't:a42dbde0c1e1090d6adf1640c2dda533',
                  },
                ],
                op: 'script',
                outputs: [
                  {
                    id: 'out',
                    name: 'out',
                    type: 'signal',
                  },
                ],
                title: 'Script',
              },
              kind: 'function',
              label: 'Custom',
              node_type: 'custom',
              status: 'ready',
            },
          },
        ],
        source_project: 'lib-e9dba9550082d44f158add0b64ac9e2c',
        styles: {
          'record:3ff1df0edb71bd65638eaa07344ef711': {
            color: null,
            disabled: false,
            folded: false,
            pinned: false,
          },
        },
        types: [
          {
            color: '#669ed6',
            control: 'textarea',
            fields: [],
            id: '64428b9c654c2c2cfcb55742ea899ed8',
            name: 'text',
          },
          {
            alias: 't:64428b9c654c2c2cfcb55742ea899ed8',
            color: '#8a6fd6',
            control: 'code',
            fields: [],
            id: 'a42dbde0c1e1090d6adf1640c2dda533',
            name: 'script',
          },
        ],
        version: 3,
        widgets: {},
        positions: {
          'record:3ff1df0edb71bd65638eaa07344ef711': {
            height: 195,
            width: 672,
            x: 0,
            y: 0,
          },
        },
      },
      description: '',
      folder: '',
      frame: {
        dx: -96,
        dy: -72,
        height: 200,
        width: 300,
      },
      grants: [],
      icon: 'code',
    },
  },
  {
    name: 'For',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: false,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: '69781ea1e4f79836ae0ade079fbc81c3',
            interface: {
              inputs: [
                {
                  bound: [
                    {
                      node_id: 'record:be809cdefebe7110a05cf031f27def6e',
                      port_id: 'in',
                    },
                  ],
                  id: 'in',
                  name: 'in',
                  type: 'signal',
                },
                {
                  default: 0,
                  id: 'from',
                  name: 'from',
                  type: 't:fbe54fdd1dd24d55a0ec083cc057017e',
                },
                {
                  default: 10,
                  id: 'to',
                  name: 'to',
                  type: 't:fbe54fdd1dd24d55a0ec083cc057017e',
                },
                {
                  default: 1,
                  id: 'step',
                  name: 'step',
                  type: 't:fbe54fdd1dd24d55a0ec083cc057017e',
                },
              ],
              outputs: [
                {
                  id: 'body',
                  name: 'body',
                  type: 'signal',
                },
                {
                  id: 'done',
                  name: 'done',
                  type: 'signal',
                },
                {
                  id: 'index',
                  name: 'index',
                  type: 't:fbe54fdd1dd24d55a0ec083cc057017e',
                },
              ],
            },
          },
        ],
        groups: [
          {
            color: null,
            folded: false,
            id: '69781ea1e4f79836ae0ade079fbc81c3',
            members: ['record:be809cdefebe7110a05cf031f27def6e'],
            name: 'For',
            parent: null,
            pinned: false,
          },
        ],
        port_edges: [],
        records: [
          {
            id: 'record:be809cdefebe7110a05cf031f27def6e',
            payload: {
              config: {
                grants: [],
                inputs: [
                  {
                    id: 'in',
                    name: 'in',
                    type: 'signal',
                  },
                  {
                    default:
                      "const {from, to, step} = node.input;\nif (![from, to, step].every(Number.isFinite)) throw new Error('For: from, to and step are numbers');\nif (step === 0) throw new Error('For: step cannot be 0');\nfor (let i = from; step > 0 ? i < to : i > to; i += step) {\n  node.output.index = i;\n  if ((await node.output.body.emit({handles: ['break', 'continue']})) === 'break') break;\n}\nawait node.output.done.emit();",
                    id: 'script',
                    name: 'script',
                    type: 't:a42dbde0c1e1090d6adf1640c2dda533',
                  },
                ],
                op: 'script',
                outputs: [
                  {
                    id: 'out',
                    name: 'out',
                    type: 'signal',
                  },
                ],
                title: 'Script',
              },
              kind: 'function',
              label: 'Custom',
              node_type: 'custom',
              status: 'ready',
            },
          },
        ],
        source_project: 'lib-39e61d57e9209611edd4f884e9e47c11',
        styles: {
          'record:be809cdefebe7110a05cf031f27def6e': {
            color: null,
            folded: false,
            pinned: false,
          },
        },
        types: [
          {
            color: '#669ed6',
            control: 'textarea',
            fields: [],
            id: '64428b9c654c2c2cfcb55742ea899ed8',
            name: 'text',
          },
          {
            alias: 't:64428b9c654c2c2cfcb55742ea899ed8',
            color: '#8a6fd6',
            control: 'code',
            fields: [],
            id: 'a42dbde0c1e1090d6adf1640c2dda533',
            name: 'script',
          },
          {
            color: '#b3d666',
            control: 'number',
            fields: [],
            id: 'fbe54fdd1dd24d55a0ec083cc057017e',
            name: 'number',
          },
        ],
        version: 3,
        widgets: {},
        positions: {
          'record:be809cdefebe7110a05cf031f27def6e': {
            x: 0,
            y: 24,
          },
        },
      },
      description:
        'Runs `body` once for each number from `from` (included) to `to` (not included), going up or down by `step`; the number is on `index`. `done` fires when the loop ends. A Break node ends it early, a Continue node ends only the pass.',
      folder: 'Flow',
      frame: {
        dx: 0,
        dy: 0,
        height: 200,
        width: 300,
      },
      grants: [],
      icon: 'loop',
    },
  },
  {
    name: 'For each',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: false,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: '8754ee968c6c7c09d4af439dfd117760',
            interface: {
              inputs: [
                {
                  bound: [
                    {
                      node_id: 'record:5bec4c119eb4201aeb688bfd462efda8',
                      port_id: 'in',
                    },
                  ],
                  id: 'in',
                  name: 'in',
                  type: 'signal',
                },
                {
                  id: 'list',
                  name: 'list',
                },
              ],
              outputs: [
                {
                  id: 'body',
                  name: 'body',
                  type: 'signal',
                },
                {
                  id: 'done',
                  name: 'done',
                  type: 'signal',
                },
                {
                  id: 'item',
                  name: 'item',
                },
                {
                  id: 'index',
                  name: 'index',
                  type: 't:fbe54fdd1dd24d55a0ec083cc057017e',
                },
              ],
            },
          },
        ],
        groups: [
          {
            color: null,
            folded: false,
            id: '8754ee968c6c7c09d4af439dfd117760',
            members: ['record:5bec4c119eb4201aeb688bfd462efda8'],
            name: 'For each',
            parent: null,
            pinned: false,
          },
        ],
        port_edges: [],
        records: [
          {
            id: 'record:5bec4c119eb4201aeb688bfd462efda8',
            payload: {
              config: {
                grants: [],
                inputs: [
                  {
                    id: 'in',
                    name: 'in',
                    type: 'signal',
                  },
                  {
                    default:
                      "const list = node.input.list;\nif (!Array.isArray(list)) throw new Error('For each: list is a list');\nfor (let i = 0; i < list.length; i++) {\n  node.output.item = list[i];\n  node.output.index = i;\n  if ((await node.output.body.emit({handles: ['break', 'continue']})) === 'break') break;\n}\nawait node.output.done.emit();",
                    id: 'script',
                    name: 'script',
                    type: 't:a42dbde0c1e1090d6adf1640c2dda533',
                  },
                ],
                op: 'script',
                outputs: [
                  {
                    id: 'out',
                    name: 'out',
                    type: 'signal',
                  },
                ],
                title: 'Script',
              },
              kind: 'function',
              label: 'Custom',
              node_type: 'custom',
              status: 'ready',
            },
          },
        ],
        source_project: 'lib-dda37e341b7c8328b940c532d8072fd4',
        styles: {
          'record:5bec4c119eb4201aeb688bfd462efda8': {
            color: null,
            folded: false,
            pinned: false,
          },
        },
        types: [
          {
            color: '#669ed6',
            control: 'textarea',
            fields: [],
            id: '64428b9c654c2c2cfcb55742ea899ed8',
            name: 'text',
          },
          {
            alias: 't:64428b9c654c2c2cfcb55742ea899ed8',
            color: '#8a6fd6',
            control: 'code',
            fields: [],
            id: 'a42dbde0c1e1090d6adf1640c2dda533',
            name: 'script',
          },
          {
            color: '#b3d666',
            control: 'number',
            fields: [],
            id: 'fbe54fdd1dd24d55a0ec083cc057017e',
            name: 'number',
          },
        ],
        version: 3,
        widgets: {},
        positions: {
          'record:5bec4c119eb4201aeb688bfd462efda8': {
            x: 0,
            y: 24,
          },
        },
      },
      description:
        'Runs `body` once for each element of `list`; the element is on `item` and its position on `index`. `done` fires when the loop ends. Break and Continue work as in For.',
      folder: 'Flow',
      frame: {
        dx: 0,
        dy: 0,
        height: 200,
        width: 300,
      },
      grants: [],
      icon: 'list',
    },
  },
  {
    name: 'Number',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: false,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: '239147f8e5a2ccf3510fb4d152545d20',
            interface: {
              inputs: [],
              outputs: [
                {
                  default: 0,
                  editable: true,
                  id: 'pvlo07',
                  name: 'number',
                  type: 't:fbe54fdd1dd24d55a0ec083cc057017e',
                },
              ],
            },
          },
        ],
        groups: [
          {
            color: null,
            disabled: false,
            folded: false,
            id: '239147f8e5a2ccf3510fb4d152545d20',
            members: [],
            name: 'Number',
            parent: null,
            pinned: false,
            position: {
              x: 0,
              y: 0,
            },
          },
        ],
        port_edges: [],
        records: [],
        source_project: 'lib-55b3c977733d0e92815bf6e65c13da5b',
        styles: {},
        types: [
          {
            color: '#b3d666',
            control: 'number',
            fields: [],
            id: 'fbe54fdd1dd24d55a0ec083cc057017e',
            name: 'number',
          },
        ],
        version: 3,
        widgets: {},
        positions: {},
      },
      description: '',
      folder: 'Value',
      frame: {
        dx: 0,
        dy: 0,
      },
      grants: [],
      icon: 'hash',
    },
  },
  {
    name: 'Preview',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: false,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: '14a414775198fc05c37e06a1a7ccec56',
            interface: {
              inputs: [
                {
                  bound: [
                    {
                      node_id: 'record:6e4208dbb04e871621658a22ae312dca',
                      port_id: 'in',
                    },
                  ],
                  id: 'pcgmyd',
                  name: 'in',
                  type: 'signal',
                },
                {
                  id: 'pezeui',
                  name: 'input',
                },
              ],
              outputs: [],
            },
          },
        ],
        groups: [
          {
            color: null,
            disabled: false,
            folded: false,
            id: '14a414775198fc05c37e06a1a7ccec56',
            members: ['record:6e4208dbb04e871621658a22ae312dca'],
            name: 'Preview',
            parent: null,
            pinned: false,
          },
        ],
        port_edges: [],
        records: [
          {
            id: 'record:6e4208dbb04e871621658a22ae312dca',
            payload: {
              config: {
                grants: [],
                inputs: [
                  {
                    id: 'in',
                    name: 'in',
                    type: 'signal',
                  },
                  {
                    default: 'node.display(node.input.input);',
                    id: 'script',
                    name: 'script',
                    type: 't:a42dbde0c1e1090d6adf1640c2dda533',
                  },
                ],
                op: 'script',
                outputs: [
                  {
                    id: 'out',
                    name: 'out',
                    type: 'signal',
                  },
                ],
                title: 'Script',
              },
              kind: 'function',
              label: 'Custom',
              node_type: 'custom',
              status: 'ready',
            },
          },
        ],
        source_project: 'lib-f44a209a1c8987a5026ad7b088f7c8f5',
        styles: {
          'record:6e4208dbb04e871621658a22ae312dca': {
            color: null,
            disabled: false,
            folded: false,
            pinned: false,
          },
        },
        types: [
          {
            color: '#669ed6',
            control: 'textarea',
            fields: [],
            id: '64428b9c654c2c2cfcb55742ea899ed8',
            name: 'text',
          },
          {
            alias: 't:64428b9c654c2c2cfcb55742ea899ed8',
            color: '#8a6fd6',
            control: 'code',
            fields: [],
            id: 'a42dbde0c1e1090d6adf1640c2dda533',
            name: 'script',
          },
        ],
        version: 3,
        widgets: {},
        positions: {
          'record:6e4208dbb04e871621658a22ae312dca': {
            x: 168,
            y: -24,
          },
        },
      },
      description: '',
      folder: '',
      frame: {
        dx: -168,
        dy: 24,
      },
      grants: [],
      icon: 'eye',
    },
  },
  {
    name: 'Text',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: false,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: '109f77d82ec8c26f55391e4b4d8e7e56',
            interface: {
              inputs: [],
              outputs: [
                {
                  editable: true,
                  id: 'pvlo07',
                  name: 'text',
                  type: 't:64428b9c654c2c2cfcb55742ea899ed8',
                },
              ],
            },
          },
        ],
        groups: [
          {
            color: null,
            disabled: false,
            folded: false,
            id: '109f77d82ec8c26f55391e4b4d8e7e56',
            members: [],
            name: 'Text',
            parent: null,
            pinned: false,
            position: {
              x: 0,
              y: 0,
            },
          },
        ],
        port_edges: [],
        records: [],
        source_project: 'lib-7d2c9d1c4b699b03dde7324c5fcdfbc9',
        styles: {},
        types: [
          {
            color: '#669ed6',
            control: 'textarea',
            fields: [],
            id: '64428b9c654c2c2cfcb55742ea899ed8',
            name: 'text',
          },
        ],
        version: 3,
        widgets: {},
        positions: {},
      },
      description: '',
      folder: 'Value',
      frame: {
        dx: 0,
        dy: 0,
      },
      grants: [],
      icon: 'text',
    },
  },
  {
    name: 'Variable',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: false,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: '5a4f9a9ccfa5a86b24ce9d108984cf3c',
            interface: {
              inputs: [
                {
                  bound: [
                    {
                      node_id: 'record:8da6cc3459d5d440c80fe7ad4ffbcc7d',
                      port_id: 'in',
                    },
                  ],
                  id: 'in',
                  name: 'set',
                  type: 'signal',
                },
                {
                  id: 'to',
                  name: 'to',
                },
              ],
              outputs: [
                {
                  id: 'done',
                  name: 'done',
                  type: 'signal',
                },
                {
                  id: 'value',
                  name: 'value',
                },
              ],
            },
          },
        ],
        groups: [
          {
            color: null,
            folded: false,
            id: '5a4f9a9ccfa5a86b24ce9d108984cf3c',
            members: ['record:8da6cc3459d5d440c80fe7ad4ffbcc7d'],
            name: 'Variable',
            parent: null,
            pinned: false,
          },
        ],
        port_edges: [],
        records: [
          {
            id: 'record:8da6cc3459d5d440c80fe7ad4ffbcc7d',
            payload: {
              config: {
                grants: [],
                inputs: [
                  {
                    id: 'in',
                    name: 'in',
                    type: 'signal',
                  },
                  {
                    default: 'node.output.value = node.input.to;\nawait node.output.done.emit();',
                    id: 'script',
                    name: 'script',
                    type: 't:a42dbde0c1e1090d6adf1640c2dda533',
                  },
                ],
                op: 'script',
                outputs: [
                  {
                    id: 'out',
                    name: 'out',
                    type: 'signal',
                  },
                ],
                title: 'Script',
              },
              kind: 'function',
              label: 'Custom',
              node_type: 'custom',
              status: 'ready',
            },
          },
        ],
        source_project: 'lib-47c14840d8e15331fa420b9b2f757cd9',
        styles: {
          'record:8da6cc3459d5d440c80fe7ad4ffbcc7d': {
            color: null,
            folded: false,
            pinned: false,
          },
        },
        types: [
          {
            color: '#669ed6',
            control: 'textarea',
            fields: [],
            id: '64428b9c654c2c2cfcb55742ea899ed8',
            name: 'text',
          },
          {
            alias: 't:64428b9c654c2c2cfcb55742ea899ed8',
            color: '#8a6fd6',
            control: 'code',
            fields: [],
            id: 'a42dbde0c1e1090d6adf1640c2dda533',
            name: 'script',
          },
        ],
        version: 3,
        widgets: {},
        positions: {
          'record:8da6cc3459d5d440c80fe7ad4ffbcc7d': {
            x: 0,
            y: 24,
          },
        },
      },
      description:
        'Holds a value: signal `set` stores `to` on `value`, then `done` fires. Reading `value` gives what was stored last (nothing before the first set).',
      folder: 'Flow',
      frame: {
        dx: 0,
        dy: 0,
        height: 200,
        width: 300,
      },
      grants: [],
      icon: 'database',
    },
  },
  {
    name: 'While',
    payload: {
      bundle: {
        complex: [
          {
            arbitrary: {
              inputs: false,
              outputs: false,
            },
            collapsed: false,
            compact_height: 90,
            compact_width: 240,
            id: '351fd5b4d746704acc28cea4aa764960',
            interface: {
              inputs: [
                {
                  bound: [
                    {
                      node_id: 'record:a87b17b08cac3cb378138c3bb5c0133d',
                      port_id: 'in',
                    },
                  ],
                  id: 'in',
                  name: 'in',
                  type: 'signal',
                },
                {
                  default: false,
                  id: 'condition',
                  name: 'condition',
                  type: 't:d1714f2eec0f4bcfa0edc8602f7f67c2',
                },
              ],
              outputs: [
                {
                  id: 'body',
                  name: 'body',
                  type: 'signal',
                },
                {
                  id: 'done',
                  name: 'done',
                  type: 'signal',
                },
              ],
            },
          },
        ],
        groups: [
          {
            color: null,
            folded: false,
            id: '351fd5b4d746704acc28cea4aa764960',
            members: ['record:a87b17b08cac3cb378138c3bb5c0133d'],
            name: 'While',
            parent: null,
            pinned: false,
          },
        ],
        port_edges: [],
        records: [
          {
            id: 'record:a87b17b08cac3cb378138c3bb5c0133d',
            payload: {
              config: {
                grants: [],
                inputs: [
                  {
                    id: 'in',
                    name: 'in',
                    type: 'signal',
                  },
                  {
                    default:
                      "while (await node.reread('condition')) {\n  if ((await node.output.body.emit({handles: ['break', 'continue']})) === 'break') break;\n}\nawait node.output.done.emit();",
                    id: 'script',
                    name: 'script',
                    type: 't:a42dbde0c1e1090d6adf1640c2dda533',
                  },
                ],
                op: 'script',
                outputs: [
                  {
                    id: 'out',
                    name: 'out',
                    type: 'signal',
                  },
                ],
                title: 'Script',
              },
              kind: 'function',
              label: 'Custom',
              node_type: 'custom',
              status: 'ready',
            },
          },
        ],
        source_project: 'lib-3cddbb8f43a4e074e2c2ce3e8622f43e',
        styles: {
          'record:a87b17b08cac3cb378138c3bb5c0133d': {
            color: null,
            folded: false,
            pinned: false,
          },
        },
        types: [
          {
            color: '#669ed6',
            control: 'textarea',
            fields: [],
            id: '64428b9c654c2c2cfcb55742ea899ed8',
            name: 'text',
          },
          {
            alias: 't:64428b9c654c2c2cfcb55742ea899ed8',
            color: '#8a6fd6',
            control: 'code',
            fields: [],
            id: 'a42dbde0c1e1090d6adf1640c2dda533',
            name: 'script',
          },
          {
            color: '#d666c2',
            control: 'checkbox',
            fields: [],
            id: 'd1714f2eec0f4bcfa0edc8602f7f67c2',
            name: 'bool',
          },
          {
            color: '#b3d666',
            control: 'number',
            fields: [],
            id: 'fbe54fdd1dd24d55a0ec083cc057017e',
            name: 'number',
          },
        ],
        version: 3,
        widgets: {},
        positions: {
          'record:a87b17b08cac3cb378138c3bb5c0133d': {
            x: 0,
            y: 24,
          },
        },
      },
      description:
        'Runs body while condition is true, reading it again before every pass. done fires when the loop ends. Break and Continue control the loop.',
      folder: 'Flow',
      frame: {
        dx: 0,
        dy: 0,
        height: 200,
        width: 300,
      },
      grants: [],
      icon: 'refresh',
    },
  },
];
