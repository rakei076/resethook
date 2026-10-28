# Grok 中继

自己保管 Grok key 时使用：ResetHook 签名 Webhook → 本中继验签 → 带 `Authorization: Bearer` 转发到 Grok Bot 例行任务。消息内容与网站直连相同。

```bash
cd adapters/grok
npx wrangler deploy --var MESSAGE_LANG:zh
echo "<Webhook 网址>" | npx wrangler secret put GROK_WEBHOOK_URL
echo "<Webhook key>" | npx wrangler secret put GROK_WEBHOOK_KEY
node ../../skill/resethook/scripts/resethook.mjs subscribe https://<worker>.workers.dev/
echo "<subscribe 返回的 secret>" | npx wrangler secret put RESETHOOK_SECRET
```

- `challenge` 原样回显；其余请求验签，超过 300 秒或签名不符返回 401；请求体限 64 KB。
- 只转发「预告」和「撤回」；`ping` 只有带 `data.wake=true` 才转发测试消息。
- 转发不跟随重定向。Grok 返回非 2xx 时回 502，ResetHook 按退避重试。
- 可选 `--var "MESSAGE_SUFFIX:<文本>"`：在每条消息末尾追加指令。
