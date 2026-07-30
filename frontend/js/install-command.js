const INSTALL_TICKET_PATTERN = /\bAuthorization:\s*Bearer\s+nsi_[a-f0-9]{48}\b/i;

export function agentInstallCommandFromPayload(payload, expectedTargetId) {
  if (!payload || payload.ok !== true) throw new Error(payload?.error || 'Worker 未返回有效安装命令');
  const targetId = String(payload.target_id || '');
  if (!targetId || targetId !== String(expectedTargetId || '')) throw new Error('安装命令与当前 Agent 不匹配，请刷新后台后重试');
  if (payload.credential_bound !== true || payload.credential_type !== 'one_time_install_token') {
    throw new Error('安装命令未绑定一次性节点凭据，请重新生成');
  }

  const command = String(payload.linux_command || payload.command || '').trim();
  if (/NSTATUS_AGENT_TOKEN\s*=|\bnst_[a-f0-9]{32,}\b/i.test(command)) {
    throw new Error('安装命令包含长期节点凭据，已拒绝复制');
  }
  const apiBase = String(payload.api_base || '').replace(/\/+$/, '');
  const expectedEndpoint = apiBase ? `${apiBase}/api/agent/install-script` : '';
  if (
    !command
    || command.length > 1024
    || command.includes('\n')
    || !INSTALL_TICKET_PATTERN.test(command)
    || !expectedEndpoint
    || !command.includes(`'${expectedEndpoint}'`)
    || !/-o "\$t" && sh "\$t"\)$/.test(command)
  ) {
    throw new Error('安装命令缺少有效的一次性节点凭据，请重新生成');
  }
  return command;
}

export async function copyText(text) {
  const value = String(text || '');
  if (!value) throw new Error('没有可复制的内容');

  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('复制失败，请检查浏览器剪贴板权限');
}
