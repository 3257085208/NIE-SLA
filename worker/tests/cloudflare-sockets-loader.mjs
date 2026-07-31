const socketsStub = 'data:text/javascript,export function connect(){throw new Error("cloudflare:sockets is unavailable in Node tests")}'

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:sockets') return { url: socketsStub, shortCircuit: true };
  return nextResolve(specifier, context);
}
