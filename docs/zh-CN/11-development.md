# 11 开发与发布

## 目录结构

```text
agent/      Rust Agent、安装脚本、二进制
frontend/   Pages 前端、后台、主题、安装资产
worker/     Worker API、D1/R2/DO 逻辑
docs/       中英文文档
tests/      smoke tests
```

## 本地验证

```bash
./test.sh
node --check worker/src/index.js
node --check frontend/js/admin.js
cd agent && cargo fmt -- --check && cargo check
```

## 发布顺序

1. 先部署 Worker schema/API。
2. 再部署 Pages 前端。
3. 更新 Agent 二进制和安装资产。
4. 先在一台测试 VPS 验证。
5. 再批量更新其他 VPS。

## 仓库卫生

不要提交真实 IP、Token、私有域名、`.wrangler`、`.env`、`agent/target` 或 wrangler 日志。修改 API、Agent 字段或后台行为时同步更新文档。
