# approval-gate

最小可跑插件骨架（pi-web-ui plugin create 生成）。

## 目录

- `manifest.json` —— 插件声明（id/name/version/description/apiVersion/permissions…；apiVersion 2 必须写 permissions，零能力写 `[]`）
- `index.mjs` —— 服务端入口（`export default { activate(host) }`）
- `client/entry.mjs` —— 客户端视图（`{ mount }`）
- `sdk/index.mjs` + `sdk/client-utils.mjs` —— plugin-sdk 拷贝（服务端用：definePlugin/defineView/onUiAction）
- `client/sdk/` —— 同一份 SDK 的**客户端**拷贝：宿主只暴露 `/plugins/<id>/client/*`，客户端依赖必须落在 `client/` 内（`client/entry.mjs` 只能 `import "./sdk/index.mjs"`）

## 下一步

1. 改名改描述：编辑 manifest.json 的 name/description。
2. 写逻辑：在 index.mjs 里接 host API（log/onMessage/broadcast/notify），视图改 client/entry.mjs。
3. 生效：服务运行中刷新浏览器即可加载（或发 `plugins_reload`）；未运行则下次启动生效。
4. 参考：官方插件 `plugins/demo-mailbox`（最小）、`plugin-sdk/README.md`（完整契约）。
