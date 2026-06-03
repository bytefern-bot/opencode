# 不改 opencode 源码适配新 model provider

这份文档说明如何在不修改当前 opencode 项目源码的前提下，接入一个新的
model provider。核心结论是：优先使用 `opencode.json` 的 custom provider；
只有在需要自定义鉴权、动态模型列表或特殊封装时才使用 plugin。

相关实现位置：

- `src/config/provider.ts`: `provider` 配置 schema。
- `src/provider/provider.ts`: provider 配置合并、模型注册、AI SDK provider 加载。
- `src/plugin/index.ts`: plugin 加载和 hook 注册。
- `packages/plugin/src/index.ts`: plugin hook 类型定义。
- `packages/web/src/content/docs/providers.mdx`: custom provider 用户文档。

## 总结

可以不改 opencode 源码适配新 provider，但方式取决于 provider 的协议能力。

```txt
OpenAI-compatible API
  -> 只写 opencode.jsonc，最稳

需要自定义 /connect、动态模型列表、共享适配逻辑
  -> 使用 plugin 辅助

完全非标准协议
  -> 写 AI SDK provider 包，再通过 opencode 配置接入
```

## 方式一：只用配置接入 OpenAI-compatible provider

这是最推荐的方式。

如果新 provider 兼容 OpenAI Chat Completions API，例如：

```txt
POST /v1/chat/completions
```

可以直接在 `opencode.jsonc` 中声明 provider。

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

然后通过环境变量提供 key：

```bash
MYPROVIDER_API_KEY=sk-xxx opencode
```

也可以使用 `/connect` 里的 `Other`，输入 provider id：

```txt
myprovider
```

这样 key 会写入 opencode 的 auth 存储，而不是写进配置文件。

### 适合场景

- provider 兼容 OpenAI Chat Completions。
- 模型列表固定，手写在配置里可以接受。
- 不需要自定义登录或 OAuth。
- 不需要特殊 request/response 转换。

### 使用 Responses API

如果 provider 或模型走 OpenAI Responses API，可以尝试：

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

## provider 配置字段

主配置里的 `provider` 每个 key 都是一个 provider id。

```jsonc
{
  "provider": {
    "myprovider": {}
  }
}
```

常用字段：

```txt
api         默认 API URL，可被 options.baseURL 覆盖
name        UI 展示名称
env         用于寻找 API key 的环境变量列表
npm         AI SDK provider package
whitelist   只保留指定模型
blacklist   排除指定模型
options     传给 AI SDK provider factory 的 options
models      模型配置表
```

`options` 常用字段：

```txt
apiKey        API key；通常不建议直接写死
baseURL       provider endpoint
timeout       请求超时，毫秒；false 表示禁用
chunkTimeout  stream chunk 超时，毫秒
headers       自定义请求头
```

模型字段常用：

```txt
id            实际传给 provider API 的模型 id；不设置时用配置 key
name          UI 展示名称
family        模型家族
attachment    是否支持附件
reasoning     是否支持 reasoning
temperature   是否支持 temperature
tool_call     是否支持 tool call
interleaved   reasoning 内容是否 interleaved
cost          价格信息
limit         context/input/output 限制
modalities    输入输出模态
status        alpha/beta/deprecated
provider      单模型覆盖 npm/api
options       单模型 options
headers       单模型 headers
variants      模型 variants
```

示例：配置 key 和真实 API 模型 id 不一致。

```jsonc
{
  "provider": {
    "myprovider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.myprovider.com/v1"
      },
      "models": {
        "fast": {
          "id": "vendor-model-fast-2026-01",
          "name": "Fast Model"
        }
      }
    }
  },
  "model": "myprovider/fast"
}
```

最终调用 provider API 时使用的是：

```txt
vendor-model-fast-2026-01
```

opencode UI 和配置里使用的是：

```txt
myprovider/fast
```

## 方式二：用 plugin 辅助注册 provider 配置

plugin 可以在 `config()` hook 里修改当前 config 对象。Provider 初始化时会先加载
plugins，然后再读取 `cfg.provider`，所以 plugin 可以注入 provider 配置。

`.opencode/plugins/my-provider.ts`：

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
  }
}
```

项目配置只需要选择模型：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "myprovider/my-model"
}
```

### 适合场景

- 想把 provider 配置封装成可复用插件。
- 不想让每个项目都复制完整 provider 配置。
- provider 配置需要根据运行环境生成。

### 注意

这种方式依赖 plugin 的 `config()` hook 对 config 对象做原地修改。当前实现支持
这个顺序，但从架构上看，它比纯 `opencode.jsonc` 更隐式。能用纯配置解决时，
优先用纯配置。

## 方式三：plugin 提供 `/connect` 鉴权入口

如果希望新 provider 出现在 `/connect` 里，可以实现 `auth` hook。

`.opencode/plugins/my-provider.ts`：

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

然后用户可以：

```txt
/connect -> My Provider -> paste API key
```

配置中选择模型：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "myprovider/my-model"
}
```

## 方式四：plugin 提供动态模型列表

plugin 的 `provider.models()` hook 可以替换指定 provider 的模型列表。

当前实现里要注意一点：`provider.models()` 只会在 provider 已经存在时执行。
所以仍然需要通过 `config()` hook 或 `opencode.jsonc` 先声明 provider。

示例：

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
        models: {},
      }
    },

    provider: {
      id: "myprovider",
      async models(provider, ctx) {
        const response = await fetch("https://api.myprovider.com/v1/models", {
          headers:
            ctx.auth?.type === "api"
              ? {
                  Authorization: `Bearer ${ctx.auth.key}`,
                }
              : undefined,
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
              api: {
                id: model.id,
                npm: provider.models[model.id]?.api.npm ?? "@ai-sdk/openai-compatible",
                url: provider.models[model.id]?.api.url ?? "",
              },
              capabilities: {
                temperature: true,
                reasoning: false,
                attachment: false,
                toolcall: true,
                input: {
                  text: true,
                  audio: false,
                  image: false,
                  video: false,
                  pdf: false,
                },
                output: {
                  text: true,
                  audio: false,
                  image: false,
                  video: false,
                  pdf: false,
                },
                interleaved: false,
              },
              cost: {
                input: 0,
                output: 0,
                cache: {
                  read: 0,
                  write: 0,
                },
              },
              limit: {
                context: 128000,
                output: 8192,
              },
              headers: {},
              options: {},
              providerID: "myprovider",
              family: "",
              release_date: "",
              status: "active",
              variants: {},
            },
          ]),
        )
      },
    },
  }
}
```

这个例子偏底层，因为 `provider.models()` 返回的是 SDK v2 的 `Model` 结构，
需要提供比较完整的模型元数据。实际项目里可以封装一个 helper 来减少重复。

## 方式五：非标准协议，写 AI SDK provider 包

如果 provider 不是 OpenAI-compatible，也没有现成的 AI SDK provider 包，
仅靠 opencode plugin 通常不够。

原因是 opencode 最终会根据模型的 `api.npm` 加载 AI SDK provider：

```txt
model.api.npm -> dynamic import -> create... factory -> sdk.languageModel(model.api.id)
```

所以需要提供一个 npm 包，例如：

```txt
@my-org/ai-sdk-myprovider
```

这个包需要导出一个 `create...` 开头的 factory，返回符合 AI SDK provider
接口的对象。

opencode 配置：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "myprovider": {
      "npm": "@my-org/ai-sdk-myprovider",
      "name": "My Provider",
      "env": ["MYPROVIDER_API_KEY"],
      "options": {
        "baseURL": "https://api.myprovider.com"
      },
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

plugin 仍然可以在这个方案里负责：

- `/connect` 鉴权。
- 注入默认 provider 配置。
- 动态模型列表。

但真正的请求协议适配应放在 AI SDK provider 包里。

## provider 加载过程

简化后的 provider 初始化流程：

```txt
1. 读取 Config.Service.get()
2. 读取 models.dev 数据库作为默认 provider/model 数据
3. 初始化 plugin，并让 plugin.config(cfg) 有机会修改 cfg
4. 从 cfg.provider 扩展 provider database
5. 从 env 和 auth 加载 API key
6. 执行 plugin.auth.loader，把 auth 转为 provider options
7. 应用内置 custom provider loader
8. 重新应用 cfg.provider 的 options/name/env
9. 执行 plugin.provider.models() 动态替换模型列表
10. 根据 whitelist/blacklist/status 过滤模型
11. 使用 model.api.npm 加载 AI SDK provider
12. 调用 sdk.languageModel(model.api.id)
```

这解释了为什么 plugin 可以辅助 provider，但最核心的模型调用仍然通过
AI SDK provider package 完成。

## 最小落地建议

### 新 provider 是 OpenAI-compatible

只加项目配置：

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
          "name": "My Model"
        }
      }
    }
  },
  "model": "myprovider/my-model"
}
```

### 想让团队复用

做成 plugin：

```txt
.opencode/plugins/my-provider.ts
```

或发布成 npm plugin：

```jsonc
{
  "plugin": ["@my-org/opencode-my-provider"],
  "model": "myprovider/my-model"
}
```

### 完全私有协议

写两个包或一个包拆两个入口：

```txt
@my-org/ai-sdk-myprovider       -> AI SDK provider factory
@my-org/opencode-myprovider     -> opencode plugin，负责 config/auth/models
```

## 验证方式

启动 opencode 后检查最终配置：

```bash
opencode debug config
```

检查 provider/model 是否出现：

```txt
/models
```

或直接把模型设为默认：

```jsonc
{
  "model": "myprovider/my-model"
}
```

如果报 provider 或 model not found，优先检查：

- provider id 是否和 `model` 前缀一致。
- `models` 里是否存在对应 model id。
- `env` 是否能找到 API key，或 `/connect` 是否保存了同名 provider id 的 key。
- plugin 是否被加载，`OPENCODE_PURE` 是否禁用了外部 plugin。
- 非 OpenAI-compatible provider 是否提供了正确的 AI SDK provider package。
