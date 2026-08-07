// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
// reads TOML on stdin, prints normalized JSON: parse-result + re-dumped-reparsed result
import { pathToFileURL } from 'node:url';
const dist = process.env.TOML_TS_DIST ?? '/tmp/dogfood/toml-ts/dist';
const { loads, dumps } = await import(pathToFileURL(dist + '/index.js').href);
const { TomlDateTime, TomlDate, TomlTime } = await import(pathToFileURL(dist + '/tz.js').href);
const chunks = []; process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const src = Buffer.concat(chunks).toString('utf8');
  const norm = v => {
    if (v instanceof TomlDateTime || v instanceof TomlDate || v instanceof TomlTime) return v.toISOString();
    if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? 'nan' : (v > 0 ? 'inf' : '-inf');
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = norm(v[k]); return o; }
    return v;
  };
  try {
    const parsed = loads(src);
    const rt = loads(dumps(parsed));
    console.log(JSON.stringify({ parsed: norm(parsed), roundtrip: norm(rt) }));
  } catch (e) { console.log(JSON.stringify({ error: e.constructor.name + ': ' + e.message })); }
});
