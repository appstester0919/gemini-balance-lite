# Gemini Balance Lite
# Gemini API 代理和负载均衡无服务器轻量版（边缘函数）

### 作者：技术爬爬虾
[B站](https://space.bilibili.com/316183842)，[Youtube](https://www.youtube.com/@Tech_Shrimp)，抖音，公众号 全网同名。转载请注明作者。


## 项目简介

Gemini API 代理, 使用边缘函数把Gemini API免费中转到国内。还可以聚合多个Gemini API Key，随机选取API Key的使用实现负载均衡，使得Gemini API免费成倍增加。

## Vercel部署(推荐)
[![Deploy to Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/tech-shrimp/gemini-balance-lite)


1. 点击部署按钮⬆️一键部署。
2. 国内使用需要配置自定义域名
    <details>
    <summary>配置自定义域名：</summary>

    ![image](/docs/images/5.png)
    </details>
3. 去[AIStudio](https://aistudio.google.com)申请一个免费Gemini API Key
<br>将API Key与自定义的域名填入AI客户端即可使用，如果有多个API Key用逗号分隔
    <details>
    <summary>以Cherry Studio为例：</summary>

    ![image](/docs/images/2.png)
    </details>




## Deno部署

1. [fork](https://github.com/tech-shrimp/gemini-balance-lite/fork)本项目
2. 登录/注册 https://dash.deno.com/
3. 创建项目 https://dash.deno.com/new_project
4. 选择此项目，填写项目名字（请仔细填写项目名字，关系到自动分配的域名）
5. Entrypoint 填写 `src/deno_index.ts` 其他字段留空 
   <details>
   <summary>如图</summary>
   
   ![image](/docs/images/3.png)
   </details>
6. 点击 <b>Deploy Project</b>
7. 部署成功后获得域名
8. 国内使用需要配置自定义域名
9. 去[AIStudio](https://aistudio.google.com)申请一个免费Gemini API Key
10. 将API Key与分配的域名填入AI客户端即可使用，如果有多个API Key用逗号分隔

<details>
<summary>以Cherry Studio为例：</summary>

![image](/docs/images/2.png)
</details>


## Cloudflare Worker 部署
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tech-shrimp/gemini-balance-lite)

0. CF Worker有可能会分配香港的CDN节点导致无法使用(Gemini不允许香港IP连接)
0. 广东地区不建议使用Cloudflare Worker 部署
1. 点击部署按钮
2. 登录Cloudflare账号
3. 链接Github账户，部署
4. 打开dash.cloudflare.com，查看部署后的worker
6. 国内使用需要配置自定义域名
<details>
<summary>配置自定义域名：</summary>

![image](/docs/images/4.png)
</details>


## Netlify部署
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/tech-shrimp/gemini-balance-lite)
<br>点击部署按钮，登录Github账户即可
<br>免费分配域名，国内可直连。
<br>但是不稳定

<details>
<summary>将分配的域名复制下来，如图：</summary>

![image](/docs/images/1.png)
</details>

去[AIStudio](https://aistudio.google.com)申请一个免费Gemini API Key
<br>将API Key与分配的域名填入AI客户端即可使用，如果有多个API Key用逗号分隔

<details>
<summary>以Cherry Studio为例：</summary>

![image](/docs/images/2.png)
</details>



## 打赏
#### 帮忙点点关注点点赞，谢谢啦~
B站：[https://space.bilibili.com/316183842](https://space.bilibili.com/316183842)<br>
Youtube: [https://www.youtube.com/@Tech_Shrimp](https://www.youtube.com/@Tech_Shrimp)


## 本地调试

1. 安装NodeJs
2. npm install -g vercel
3. cd 项目根目录
4. vercel dev

## API 说明


### Gemini 代理

可以使用 Gemini 的原生 API 格式进行代理请求。
**Curl 示例:**
```bash
curl -X POST --location 'https://<YOUR_DEPLOYED_DOMAIN>/v1beta/models/gemini-2.5-pro:generateContent' \
--header 'Content-Type: application/json' \
--header 'x-goog-api-key: <YOUR_GEMINI_API_KEY_1>,<YOUR_GEMINI_API_KEY_2>' \
--data '{
    "contents": [
        {
         "role": "user",
         "parts": [
            {
               "text": "Hello"
            }
         ]
      }
    ]
}'
```
**Curl 示例:（流式）**
```bash
curl -X POST --location 'https://<YOUR_DEPLOYED_DOMAIN>/v1beta/models/gemini-2.5-pro:generateContent?alt=sse' \
--header 'Content-Type: application/json' \
--header 'x-goog-api-key: <YOUR_GEMINI_API_KEY_1>,<YOUR_GEMINI_API_KEY_2>' \
--data '{
    "contents": [
        {
         "role": "user",
         "parts": [
            {
               "text": "Hello"
            }
         ]
      }
    ]
}'
```
> 注意: 请将 `<YOUR_DEPLOYED_DOMAIN>` 替换为你的部署域名，并将 `<YOUR_GEMINI_API_KEY>` 替换为你的 Gemini API Ke，如果有多个用逗号分隔


### API Key 校验

可以通过向 `/verify` 端点发送请求来校验你的 API Key 是否有效。可以一次性校验多个 Key，用逗号隔开。

**Curl 示例:**
```bash
curl -X POST --location 'https://<YOUR_DEPLOYED_DOMAIN>/verify' \
--header 'x-goog-api-key: <YOUR_GEMINI_API_KEY_1>,<YOUR_GEMINI_API_KEY_2>'
```

### OpenAI 格式

本项目兼容 OpenAI 的 API 格式，你可以通过 `/chat` 或 `/chat/completions` 端点来发送请求。

**Curl 示例:**
```bash
curl -X POST --location 'https://<YOUR_DEPLOYED_DOMAIN>/chat/completions' \
--header 'Content-Type: application/json' \
--header 'Authorization: Bearer <YOUR_GEMINI_API_KEY>' \
--data '{
    "model": "gpt-3.5-turbo",
    "messages": [
        {
            "role": "user",
            "content": "你好"
        }
    ]
}'
```


### Audio Output (TTS)

Fork 扩展：支持 Audio -> Audio 模式（语音输入 -> 语音输出 / TTS）。
在 OpenAI 格式请求中追加 `modalities` 和 `audio` 字段即可触发 Gemini 的
`responseModalities` + `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`。
响应 `choices[0].message.content` 会以**数组形式**返回，同时包含文本片段和
`{type: "output_audio", data, format}` 音频片段（base64 编码）。

**Curl 示例（TTS）：**
```bash
curl --location 'https://<YOUR_DEPLOYED_DOMAIN>/chat/completions' \
--header 'Content-Type: application/json' \
--header 'Authorization: Bearer <YOUR_...KEY>' \
--data '{
    "model": "gemini-2.5-flash-preview-tts",
    "messages": [
        { "role": "user", "content": "用普通话说一句：语音输出正常。" }
    ],
    "modalities": ["text", "audio"],
    "audio": { "voice": "Kore", "format": "wav" }
}'
```

**可用音色（节选）：** `Kore`, `Puck`, `Charon`, `Fenrir`, `Aoede` 等，
完整列表见 [Gemini TTS voices](https://ai.google.dev/gemini-api/docs/speech-generation#voices)。

**快速自检端点：** `POST /verify-audio` 会自动发送一段 canned A2A 请求，
返回 200 即代表 TTS 链路正常。

### Audio → Audio (Transcribe + Translate + TTS)

`POST /v1/audio/speech` — 接收音频输入，串行调用
`gemini-3.5-transcribe` → `gemini-2.5-flash`（翻译）→ `gemini-2.5-flash-preview-tts`（TTS），
最终返回包含 transcript、translation 以及 base64 编码 WAV 音频的 JSON。

**Curl 示例：**
```bash
curl -X POST https://<YOUR_DEPLOYED_DOMAIN>/v1/audio/speech \
  -H "Authorization: Bearer <YOUR_GEMINI_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "audio": { "data": "<base64>", "mimeType": "audio/wav" },
    "source_lang": "yue",
    "target_lang": "zh",
    "voice": "Kore"
  }'
```

**Response:**
```json
{
  "transcript": "你好嗎",
  "translation": "How are you?",
  "audio": { "data": "<base64>", "format": "audio/L16;rate=24000" },
  "voice": "Kore",
  "source_lang": "yue",
  "target_lang": "zh"
}
```

**约束：** `gemini-2.5-flash-preview-tts` 仅接受 `responseModalities:["AUDIO"]`，
本端点内部已硬编码该设置，调用方无需关心。

**快速自检端点：** `POST /verify-audio-translate` 会发送一段 canned A2A 请求，

### Audio \xe2\x86\x92 Text (Transcription)

`POST /v1/audio/transcriptions` \xe2\x86\x92 accepts OpenAI-style request, forwards to Gemini's `gemini-3.5-transcribe` model.

**Curl \xe7\xa4\xba\xe4\xbe\x8b\xef\xbc\x9a**
```bash
curl -X POST https://<YOUR_DEPLOYED_DOMAIN>/v1/audio/transcriptions \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.5-transcribe",
    "audio": { "data": "<base64-audio>", "mimeType": "audio/wav" },
    "prompt": "Transcribe this Cantonese audio into written Cantonese, then translate to Mandarin",
    "language": "yue"
  }'
```

**Response:**
```json
{ "text": "...", "language": "yue", "model": "gemini-3.5-transcribe" }
```

�\x9c\x93\xe2\x9c\x93 **�\xbf\xab\xe9\x80\x9f\xe8\x87\xaa\xe6\xa3�\xe7\xab\xaf\xe7\x82\xb9\xef\xbc\x9a** `POST /verify-transcribe` \xef\xbc\x88\xe6\x97\xa0\xe9\x9c\x80\xe8\xaf\xb7\xe6\xb1\x82\xe4\xbd\x93\xef\xbc\x89\xe3\x80\x82
返回 `ok:true` 即代表 transcribe → translate → TTS 链路全部正常。
