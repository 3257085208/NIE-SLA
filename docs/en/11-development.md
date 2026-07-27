# Development and Release

Production Agent/Worker source lives in this private repository. Production frontend source is the sibling private frontend repository. Public source is generated only through the one-way desensitized export tool.

```bash
bash test.sh
cd agent
./build-release.sh
```

The Agent build produces Linux amd64/arm64/armv7/armv6/386, one version file, and one checksum manifest. Update every installer default and copy the complete artifact set to the production frontend.

Private Worker deployment runs `worker/deploy.sh`, which prepares Static Assets before Wrangler deployment. Public one-click deployment uses its root build script.

Run the public export in dry-run mode before `--apply`, then review the safety scan and diff.
