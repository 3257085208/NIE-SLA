export function latestAgentTaskMaps(tasks) {
  const byAgent = new Map();
  const byAction = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const agentId = String(task?.agent_id || "");
    const action = String(task?.action || "");
    if (!agentId || !action) continue;
    if (!byAgent.has(agentId)) byAgent.set(agentId, task);
    const actionKey = `${agentId}:${action}`;
    if (!byAction.has(actionKey)) byAction.set(actionKey, task);
  }
  return { byAgent, byAction };
}
