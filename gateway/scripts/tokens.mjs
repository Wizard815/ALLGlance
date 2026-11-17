#!/usr/bin/env node
// Household and person tokens for the gateway. Run it where the gateway's data lives:
//
//   docker exec allglance node scripts/tokens.mjs add-household <name>
//   docker exec allglance node scripts/tokens.mjs add-person <owner_id> [name] [--also <id>]...
//   docker exec allglance node scripts/tokens.mjs list
//   docker exec allglance node scripts/tokens.mjs revoke <name>
//
// add-household   a blanket family token (e.g. the kitchen tablet): shared items and every
//                 member's non-private items, never private ones.
// add-person      one member's token: the same, plus that member's own private items.
//                 owner_id comes from GET /api/allglance/users. When the same person has another
//                 id in another app (a Vikunja user id and a dayGLANCE id), add it with --also.
// list            every token, without secrets.
// revoke <name>   stops that token at once.
//
// A new token is printed once; only its sha-256 is kept, in $ALLGLANCE_TOKENS_FILE
// (default /data/tokens.json, the gateway's data volume). --file <path> overrides it.
// The gateway re-reads the file on the next request: no restart needed.

import { issueToken, revokeToken, readTokens, describeTokens } from '../src/access.js';

function parseArgs(argv) {
  const out = { _: [], also: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--also') out.also.push(argv[++i] ?? '');
    else if (a === '--file') out.file = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else out._.push(a);
  }
  return out;
}

/** Look the id up in the running gateway's roster, when one answers here. Never fails. */
async function rosterNote(ids, env) {
  const port = env.GATEWAY_PORT || 8090;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/allglance/users`, {
      headers: env.GATEWAY_TOKEN ? { authorization: `Bearer ${env.GATEWAY_TOKEN}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return '';
    const { users = [] } = await res.json();
    const missing = ids.filter((id) => !users.some((u) => String(u.id) === id));
    if (!missing.length) return `Roster: ${ids.map((id) => `${id} is ${users.find((u) => String(u.id) === id).name}`).join('; ')}.`;
    return `Warning: ${missing.join(', ')} is not in the gateway's roster right now (GET /api/allglance/users). Check the id; a wrong one sees no private items.`;
  } catch {
    return '';
  }
}

export async function run(argv, { env = process.env, log = console.log } = {}) {
  const args = parseArgs(argv);
  const [cmd, ...rest] = args._;
  const file = args.file || env.ALLGLANCE_TOKENS_FILE || '/data/tokens.json';
  const issued = (kind, name, token) => {
    log(`Token "${name}" (${kind}). It is shown only now; store it in that app's settings:\n\n  ${token}\n`);
    log('Send it as Authorization: Bearer <token>. Check it with GET /api/allglance/whoami.');
    if (!env.GATEWAY_TOKEN) log('Note: scoped tokens only limit callers when the gateway has GATEWAY_TOKEN set. Without it anyone can leave the token out and see everything.');
  };
  switch (args.help ? 'help' : cmd) {
    case 'add-household': {
      const { token, record } = issueToken(file, { kind: 'household', name: rest[0] });
      issued('household', record.name, token);
      return { token, record };
    }
    case 'add-person': {
      const [ownerId, name] = rest;
      if (!ownerId) throw new Error('give the owner_id: add-person <owner_id> [name]. Ids: GET /api/allglance/users');
      const { token, record } = issueToken(file, { kind: 'person', name: name || ownerId, owner_id: ownerId, also: args.also });
      issued(`person: ${record.owner_id}${record.also?.length ? `, also ${record.also.join(', ')}` : ''}`, record.name, token);
      const note = await rosterNote([record.owner_id, ...(record.also ?? [])], env);
      if (note) log(note);
      return { token, record };
    }
    case 'list': {
      const tokens = describeTokens(readTokens(file));
      if (!tokens.length) log(`No household or person tokens in ${file}.`);
      for (const t of tokens) {
        const who = t.kind === 'person' ? `person ${t.owner_id}${t.also.length ? ` (also ${t.also.join(', ')})` : ''}` : 'household';
        log(`${t.name.padEnd(24)} ${who.padEnd(28)} made ${t.created}`);
      }
      return tokens;
    }
    case 'revoke': {
      if (!rest[0]) throw new Error('give the token name: revoke <name> (see list)');
      const n = revokeToken(file, rest[0]);
      if (!n) throw new Error(`no token named "${rest[0]}" in ${file}`);
      log(`Revoked "${rest[0]}". Anything using it is refused from the next request.`);
      return { revoked: rest[0] };
    }
    default: {
      const { readFileSync } = await import('node:fs');
      log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
      return null;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}
