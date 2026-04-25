import { readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

import { createGenerator } from 'ts-json-schema-generator';

const ROOT = resolve(__dirname, '..');

interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  const?: string;
  enum?: string[];
  [key: string]: unknown;
}

function readPackageVersion(): string {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    version?: string;
  };
  return packageJson.version ?? '0.0.0';
}

function generateSchema(typeName: string): JsonSchema {
  const generator = createGenerator({
    path: resolve(ROOT, 'core/src/messages.ts'),
    tsconfig: resolve(ROOT, 'tsconfig.json'),
    type: typeName,
    skipTypeCheck: true,
    additionalProperties: false,
  });
  return generator.createSchema(typeName) as JsonSchema;
}

function resolveRef(schema: JsonSchema): JsonSchema {
  const defs = schema.$defs ?? schema.definitions ?? {};
  const ref = schema.$ref;
  if (!ref) return schema;
  const key = ref.replace(/^#\/(\$defs|definitions)\//, '');
  return defs[key] ?? schema;
}

function getVariantName(variant: JsonSchema): string | null {
  const typeProp = variant.properties?.['type'];
  if (!typeProp) return null;
  if (typeof typeProp.const === 'string') return typeProp.const;
  if (Array.isArray(typeProp.enum) && typeProp.enum.length === 1) return typeProp.enum[0] ?? null;
  return null;
}

function buildAsyncApi(version: string): Record<string, unknown> {
  const serverSchema = generateSchema('ServerMessage');
  const clientSchema = generateSchema('ClientMessage');

  const serverResolved = resolveRef(serverSchema);
  const clientResolved = resolveRef(clientSchema);

  const serverVariants: JsonSchema[] = serverResolved.anyOf ?? serverResolved.oneOf ?? [];
  const clientVariants: JsonSchema[] = clientResolved.anyOf ?? clientResolved.oneOf ?? [];

  const serverNames = serverVariants.map(getVariantName).filter((n): n is string => n !== null);
  const clientNames = clientVariants.map(getVariantName).filter((n): n is string => n !== null);

  const allDefs: Record<string, unknown> = {
    ...(serverSchema.$defs ?? serverSchema.definitions ?? {}),
    ...(clientSchema.$defs ?? clientSchema.definitions ?? {}),
  };

  const messagePayloads: Record<string, JsonSchema> = {};
  for (const [index, name] of serverNames.entries()) {
    const variant = serverVariants[index];
    if (variant) messagePayloads[name] = variant;
  }
  for (const [index, name] of clientNames.entries()) {
    const variant = clientVariants[index];
    if (variant) messagePayloads[name] = variant;
  }

  const allNames = [...serverNames, ...clientNames];

  const channelMessages = Object.fromEntries(
    allNames.map((name) => [name, { $ref: `#/components/messages/${name}` }]),
  );

  const components = {
    messages: Object.fromEntries(
      allNames.map((name) => [
        name,
        {
          name,
          title: name,
          payload: messagePayloads[name] ?? {},
        },
      ]),
    ),
    schemas: allDefs,
  };

  return {
    asyncapi: '3.0.0',
    info: {
      title: 'Pixel Agents WebSocket API',
      version,
      description:
        'WebSocket protocol for the Pixel Agents standalone host. ' +
        'Connect to ws://localhost:3210/ws. ' +
        'Send webviewReady after connecting to receive the initial bootstrap.',
    },
    servers: {
      standalone: {
        host: 'localhost:3210',
        protocol: 'ws',
        description: 'Standalone host (default port)',
      },
    },
    channels: {
      ws: {
        address: '/ws',
        messages: channelMessages,
      },
    },
    operations: {
      receiveMessage: {
        action: 'receive',
        channel: { $ref: '#/channels/ws' },
        summary: 'Messages sent from the server to the browser client',
        messages: serverNames.map((name) => ({ $ref: `#/channels/ws/messages/${name}` })),
      },
      sendMessage: {
        action: 'send',
        channel: { $ref: '#/channels/ws' },
        summary: 'Messages sent from the browser client to the server',
        messages: clientNames.map((name) => ({ $ref: `#/channels/ws/messages/${name}` })),
      },
    },
    components,
  };
}

function buildOpenApi(version: string): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Pixel Agents Standalone Host HTTP API',
      version,
      description:
        'HTTP endpoints exposed by the Pixel Agents standalone host. ' +
        'Browser realtime messaging uses WebSocket at /ws and is documented in asyncapi.json.',
    },
    servers: [
      {
        url: 'http://localhost:3210',
        description: 'Standalone host (default port)',
      },
    ],
    paths: {
      '/api/health': {
        get: {
          operationId: 'getStandaloneHealth',
          summary: 'Get standalone host health and runtime details',
          responses: {
            '200': {
              description: 'Standalone host status and runtime metadata',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/StandaloneHealthResponse',
                  },
                  examples: {
                    standalone: {
                      value: {
                        status: 'ok',
                        browserPort: 3210,
                        hookPort: 4321,
                        workspaceDir: '/workspace/project',
                        assetsRoot: '/workspace/pixel-agents/webview-ui/public',
                        uptime: 12,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        StandaloneHealthResponse: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: {
              type: 'string',
              enum: ['ok'],
            },
            browserPort: {
              type: 'integer',
            },
            hookPort: {
              type: 'integer',
              nullable: true,
            },
            workspaceDir: {
              type: 'string',
            },
            assetsRoot: {
              type: 'string',
            },
            uptime: {
              type: 'integer',
              minimum: 0,
            },
          },
          required: ['status', 'browserPort', 'hookPort', 'workspaceDir', 'assetsRoot', 'uptime'],
        },
      },
    },
  };
}

function writeJson(fileName: string, document: Record<string, unknown>): void {
  const outPath = resolve(ROOT, fileName);
  writeFileSync(outPath, JSON.stringify(document, null, 2) + '\n');
  console.log(`Generated ${outPath}`);
}

const version = readPackageVersion();
const asyncApiDoc = buildAsyncApi(version);
const openApiDoc = buildOpenApi(version);

writeJson('asyncapi.json', asyncApiDoc);
console.log(
  `  ${Object.keys((asyncApiDoc.components as { messages: object }).messages).length} messages documented`,
);
writeJson('openapi.json', openApiDoc);
console.log('  1 HTTP endpoint documented');
