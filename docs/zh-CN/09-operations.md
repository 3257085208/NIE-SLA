# 09 运维与故障排查

## 日常检查

```bash
./test.sh
curl https://your-worker.example.com/
```

后台定期确认探针在线、Ping 管理可加载、流量持续增长、TG 测试可达、D1/R2 用量正常。

## Agent 没版本号

通常是 Agent 旧、Worker 旧、或刚安装未完成首次上报。执行 `cftz update`，重启 `nstatus-metrics`，再看日志。

## 流量一直 0

确认 Agent ID 与目标 ID 一致、该 VPS 开启流量、设置了额度、Agent 至少上报两次。第一次上报只建立基准，第二次起才累计差值。

## 安装命令 404

确认 Pages 已部署 `install.sh`，`PUBLIC_AGENT_INSTALL_BASE` 指向当前前端域名，不要使用旧临时 Pages 地址。

## sudo not found

如果当前已经是 root，不需要 sudo。使用后台生成的新命令会自动判断 root / sudo。

## TG 不报警

确认全局报警开关、Bot Token、Chat ID、单台 VPS 报警开关、冷却时间、cron 是否正常。
