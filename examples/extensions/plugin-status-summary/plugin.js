window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'nstatus:status') return;
  const targets = Array.isArray(event.data.payload?.targets) ? event.data.payload.targets : [];
  const online = targets.filter(target => Number(target.ok) === 1).length;
  document.getElementById('total').textContent = String(targets.length);
  document.getElementById('online').textContent = String(online);
  document.getElementById('offline').textContent = String(targets.length - online);
  document.getElementById('state').hidden = true;
  document.getElementById('summary').hidden = false;
});

parent.postMessage({ type: 'nstatus:ready' }, '*');
