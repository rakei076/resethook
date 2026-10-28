# 自己接收 Webhook

不用 Grok Bot 时，可以订阅签名 Webhook，由自己的服务器接收。

## 订阅

```bash
node scripts/resethook.mjs subscribe https://<你的域名>/hooks/reset
```

- 地址须为 `https://`、443 端口、域名（不接受 IP 和内网地址）、不跳转、10 秒内响应。
- 订阅时 ResetHook 发送 `{"type":"challenge","challenge":"<随机串>"}`，原样返回该随机串即完成验证。
- 返回的 `secret`（验签）和 `manage_url`（发测试、删除）只显示一次。

## 验签

请求头 `X-Resethook-Signature: t=<unix>,v1=<hex>`，`hex = HMAC-SHA256(secret, t + "." + 原始请求体)`，`|now − t| > 300` 秒拒绝。

```bash
node scripts/resethook.mjs verify --secret whsec_… --header "t=…,v1=…" < body.json
```

## 失败重试

非 2xx 按 1、2、4、8、16、32、60、60、60 分钟重试；连续失败 8 次停用。

## 不用 Webhook

每分钟一次 `node scripts/resethook.mjs status --json`，读 `open_announcement`。
