# Adapting a new model provider without changing opencode code

This document explains how to add a new model provider without modifying the
opencode source code. It focuses on the current implementation in
`packages/opencode/src/provider/provider.ts`, `packages/opencode/src/config/provider.ts`,
and `packages/plugin/src/index.ts`.

## Summary

There are three practical levels of integration:

1. Use `opencode.json` / `opencode.jsonc` only.
2. Use a plugin to inject provider config, auth, or model metadata.
3. Publish or reference an AI SDK provider package, then configure opencode to
   load it.

For most OpenAI-compatible APIs, the first option is enough.

Use a plugin only when the provider needs custom `/connect` behavior, dynamic
model discovery, custom auth-to-options conversion, or a reusable packaged
integration.

If the provider is not OpenAI-compatible and has no existing AI SDK provider
package, a plugin alone is usually not enough. opencode ultimately creates
models through an AI SDK provider loaded from `provider.npm`.

## Recommended path

```txt
Provider has OpenAI-compatible /v1/chat/completions API
  -> Use opencode.jsonc with @ai-sdk/openai-compatible.

Provider has OpenAI-compatible /v1/responses API
  -> Use opencode.jsonc with @ai-sdk/openai.

Provider needs custom auth, dynamic model list, or reusable distribution
  -> Add a plugin, but still configure provider.npm.

Provider uses a non-standard protocol
  -> Implement or reuse an AI SDK provider package, then reference it from config.
```

## Option 1: config-only provider

This is the simplest and most stable approach.

Create or update `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My Provider",
      "env": ["MYPROVIDER_API_KEY"],
      "options": {
        "baseURL": "https://api.myprovider.com/v1"
      },
      "models": {
        "my-model": {
          "name": "My Model",
          "tool_call": true,
          "reasoning": false,
          "temperature": true,
          "limit": {
            "context": 128000,
            "output": 8192
          }
        }
      }
    }
  },
  "model": "myprovider/my-model"
}
```

Then provide the API key with an environment variable:

```bash
MYPROVIDER_API_KEY=sk-xxx opencode
```

Or use `/connect`, choose `Other`, and enter the provider ID:

```txt
myprovider
```

The provider ID in `/connect` must match the key under `provider` in config.

### Responses API provider

If the provider is compatible with the OpenAI Responses API instead of
Chat Completions, use `@ai-sdk/openai`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai",
      "name": "My Provider",
      "env": ["MYPROVIDER_API_KEY"],
      "options": {
        "baseURL": "https://api.myprovider.com/v1"
      },
      "models": {
        "my-responses-model": {
          "name": "My Responses Model",
          "tool_call": true,
          "limit": {
            "context": 128000,
            "output": 8192
          }
        }
      }
    }
  },
  "model": "myprovider/my-responses-model"
}
```

## Config fields

Provider config is validated by `ConfigProvider.Info`.

Important fields:

- `api`: provider API URL fallback.
- `name`: display name in UI.
- `env`: environment variables used as API key sources.
- `npm`: AI SDK provider package.
- `whitelist`: allow only selected model IDs.
- `blacklist`: hide selected model IDs.
- `options`: provider factory options.
- `models`: model metadata map.

Model fields:

- `id`: API model ID if different from the config key.
- `name`: display name.
- `family`: model family string.
- `release_date`: release date string.
- `attachment`: whether attachments are supported.
- `reasoning`: whether reasoning is supported.
- `temperature`: whether temperature is supported.
- `tool_call`: whether tool calls are supported.
- `interleaved`: interleaved reasoning config.
- `cost`: input/output/cache pricing metadata.
- `limit`: context/input/output token limits.
- `modalities`: input and output modalities.
- `status`: `alpha`, `beta`, or `deprecated`.
- `provider`: per-model `npm` or `api` override.
- `options`: model-level options.
- `headers`: model-level headers.
- `variants`: variant-specific configuration.

Example with API model ID different from UI ID:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My Provider",
      "options": {
        "baseURL": "https://api.myprovider.com/v1"
      },
      "models": {
        "fast": {
          "id": "vendor-model-fast-2026-01",
          "name": "Fast Model",
          "tool_call": true,
          "limit": {
            "context": 64000,
            "output": 4096
          }
        }
      }
    }
  },
  "model": "myprovider/fast"
}
```

opencode will use:

```txt
provider ID: myprovider
opencode model ID: fast
API model ID: vendor-model-fast-2026-01
```

## How opencode loads the provider

At runtime, provider loading roughly works like this:

1. Load resolved opencode config.
2. Load models.dev provider database.
3. Extend the database with `config.provider`.
4. Load API keys from environment variables and auth storage.
5. Load plugin hooks.
6. Let plugin auth loaders patch provider options.
7. Re-apply config provider options.
8. Let plugin `provider.models()` replace or provide model metadata.
9. Filter providers and models by `enabled_providers`, `disabled_providers`,
   `whitelist`, `blacklist`, `alpha`, and `deprecated` status.
10. When a model is used, resolve the SDK from `model.api.npm`.
11. Call `sdk.languageModel(model.api.id)` unless a custom internal model loader
    exists for that provider.

The important point is that opencode still needs an AI SDK-compatible provider
factory. That factory comes from:

- a bundled provider,
- an installed npm package,
- or a `file://` provider module.

## Option 2: plugin-assisted provider

Use a plugin when the provider config should be distributed as code or when the
integration needs custom auth or dynamic model metadata.

Example local plugin:

```txt
.opencode/
  plugins/
    my-provider.ts
```

`.opencode/plugins/my-provider.ts`:

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const MyProviderPlugin: Plugin = async () => {
  return {
    async config(config) {
      config.provider ??= {}
      config.provider.myprovider = {
        npm: "@ai-sdk/openai-compatible",
        name: "My Provider",
        env: ["MYPROVIDER_API_KEY"],
        options: {
          baseURL: "https://api.myprovider.com/v1",
        },
        models: {
          "my-model": {
            name: "My Model",
            tool_call: true,
            temperature: true,
            limit: {
              context: 128000,
              output: 8192,
            },
          },
        },
      }
    },

    provider: {
      id: "myprovider",
      async models(provider) {
        return provider.models
      },
    },
  }
}
```

Then select the model in config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "myprovider/my-model"
}
```

### Why this works

Provider initialization loads plugins before reading `cfg.provider` entries.
The plugin `config()` hook receives the resolved config object. Mutating
`config.provider` there makes the provider visible to the provider loader.

This pattern is useful, but it is more implicit than writing provider config
directly in `opencode.jsonc`. Prefer config-only unless a plugin gives a clear
benefit.

## Plugin auth hook

Use `auth` when you want the provider to appear in `/connect`.

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const MyProviderPlugin: Plugin = async () => {
  return {
    auth: {
      provider: "myprovider",
      methods: [
        {
          type: "api",
          label: "My Provider",
          prompts: [
            {
              type: "text",
              key: "apiKey",
              message: "API key",
              placeholder: "sk-...",
            },
          ],
          async authorize(inputs) {
            return {
              type: "success",
              key: inputs?.apiKey ?? "",
            }
          },
        },
      ],
    },

    async config(config) {
      config.provider ??= {}
      config.provider.myprovider = {
        npm: "@ai-sdk/openai-compatible",
        name: "My Provider",
        options: {
          baseURL: "https://api.myprovider.com/v1",
        },
        models: {
          "my-model": {
            name: "My Model",
          },
        },
      }
    },
  }
}
```

After this, `/connect` can store credentials for `myprovider`.

## Plugin auth loader

Use `auth.loader` when stored credentials need to become provider options.

Example:

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const MyProviderPlugin: Plugin = async () => {
  return {
    auth: {
      provider: "myprovider",
      loader: async (getAuth) => {
        const auth = await getAuth()
        if (!auth) return {}
        if (auth.type === "api") {
          return {
            apiKey: auth.key,
            headers: {
              "X-Provider-Mode": "custom",
            },
          }
        }
        return {}
      },
      methods: [
        {
          type: "api",
          label: "My Provider",
          prompts: [
            {
              type: "text",
              key: "apiKey",
              message: "API key",
            },
          ],
          async authorize(inputs) {
            return {
              type: "success",
              key: inputs?.apiKey ?? "",
            }
          },
        },
      ],
    },

    async config(config) {
      config.provider ??= {}
      config.provider.myprovider = {
        npm: "@ai-sdk/openai-compatible",
        name: "My Provider",
        models: {
          "my-model": {
            name: "My Model",
          },
        },
      }
    },
  }
}
```

## Dynamic model list

Use `provider.models()` when the provider has a model-list endpoint.

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const MyProviderPlugin: Plugin = async () => {
  return {
    async config(config) {
      config.provider ??= {}
      config.provider.myprovider = {
        npm: "@ai-sdk/openai-compatible",
        name: "My Provider",
        options: {
          baseURL: "https://api.myprovider.com/v1",
        },
        models: {
          fallback: {
            name: "Fallback Model",
          },
        },
      }
    },

    provider: {
      id: "myprovider",
      async models(provider, ctx) {
        const apiKey = ctx.auth?.type === "api" ? ctx.auth.key : undefined
        const response = await fetch(`${provider.options.baseURL}/models`, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        })
        const data = (await response.json()) as {
          data: Array<{ id: string; name?: string }>
        }

        return Object.fromEntries(
          data.data.map((model) => [
            model.id,
            {
              id: model.id,
              name: model.name ?? model.id,
              tool_call: true,
              temperature: true,
              limit: {
                context: 128000,
                output: 8192,
              },
            },
          ]),
        )
      },
    },
  }
}
```

The provider must already exist in the provider map. The simplest way is to add
it through the plugin `config()` hook or through `opencode.jsonc`.

## Option 3: custom AI SDK provider package

If the provider is not OpenAI-compatible, implement an AI SDK provider package.

Example config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myprovider": {
      "npm": "@my-org/ai-sdk-myprovider",
      "name": "My Provider",
      "env": ["MYPROVIDER_API_KEY"],
      "options": {
        "endpoint": "https://api.myprovider.com"
      },
      "models": {
        "my-model": {
          "name": "My Model",
          "tool_call": true,
          "limit": {
            "context": 128000,
            "output": 8192
          }
        }
      }
    }
  },
  "model": "myprovider/my-model"
}
```

opencode dynamically imports the package and looks for an exported factory whose
name starts with `create`.

Conceptually, the package should expose something like:

```ts
export function createMyProvider(options: Record<string, unknown>) {
  return {
    languageModel(modelID: string) {
      // Return an AI SDK compatible LanguageModel.
    },
  }
}
```

For local development, `npm` may point to a `file://` module:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myprovider": {
      "npm": "file:///absolute/path/to/my-ai-sdk-provider.ts",
      "models": {
        "my-model": {
          "name": "My Model"
        }
      }
    }
  },
  "model": "myprovider/my-model"
}
```

## What plugin cannot cleanly do today

Plugin can help with provider config, auth, and model metadata. It does not
currently provide a public hook that directly replaces the SDK provider factory
or `LanguageModel` creation for arbitrary external providers.

The core model creation path is still:

```txt
model.api.npm -> import provider factory -> sdk.languageModel(model.api.id)
```

Some internal providers have custom model loaders, but those are implemented in
opencode's provider layer, not through the public plugin API.

Therefore:

- For OpenAI-compatible providers, use config.
- For dynamic metadata and auth, use plugin.
- For a new protocol, provide an AI SDK provider package.

## Minimal checklist

For a config-only provider:

1. Pick a stable provider ID, for example `myprovider`.
2. Add `provider.myprovider` to `opencode.jsonc`.
3. Set `npm` to `@ai-sdk/openai-compatible` or another AI SDK provider package.
4. Set `options.baseURL`.
5. Add at least one model under `models`.
6. Provide credentials through `env`, `/connect Other`, or `options.apiKey`.
7. Set `model` to `myprovider/<model-id>`.
8. Run `/models` or `opencode debug config` to confirm it is visible.

For a plugin-assisted provider:

1. Add `.opencode/plugins/my-provider.ts`.
2. Use `config()` to inject `config.provider.myprovider`.
3. Optionally add `auth` so `/connect` can store credentials.
4. Optionally add `provider.models()` for dynamic model discovery.
5. Set `model` in `opencode.jsonc`.

For a non-standard provider:

1. Implement or reuse an AI SDK provider package.
2. Point `provider.myprovider.npm` to that package.
3. Configure models and credentials in opencode config.
4. Use plugin only for auth and model discovery if needed.
