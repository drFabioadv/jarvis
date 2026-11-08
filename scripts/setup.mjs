#!/usr/bin/env node
// JARVIS preflight — a friendly, advisory check you run with `npm run setup`.
//
// It changes nothing and installs nothing. It looks at your machine, tells you
// what is ready and what is missing, and prints the two commands that start
// JARVIS. Every check degrades to a single friendly line if something is not
// there, and the script always exits 0 — it is advice, not a gate.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const tick = '  ok  ';
const warn = ' ATENCAO ';
const info = '  ·   ';

function line(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

console.log('');
console.log('JARVIS — verificando o seu computador (nada e alterado)');
console.log('------------------------------------------------------------');

// --- Node version --------------------------------------------------------
try {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major >= 20) {
    line(tick, `Node.js ${process.versions.node} (precisa ser 20 ou mais novo).`);
  } else {
    line(warn, `Node.js ${process.versions.node} e antigo. Atualize para a versao 20 ou mais nova em https://nodejs.org`);
  }
} catch {
  line(warn, 'Nao foi possivel ler a versao do Node.js. O JARVIS precisa do Node 20 ou mais novo.');
}

// --- Claude CLI on PATH ---------------------------------------------------
let claudeFound = false;
try {
  const res = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000, shell: process.platform === 'win32' });
  if (res.status === 0 && res.stdout) {
    claudeFound = true;
    line(tick, `Claude Code encontrado: ${res.stdout.trim()}`);
  }
} catch {
  // ignore — handled below
}
if (!claudeFound) {
  line(warn, 'Claude Code nao encontrado.');
  line(info, 'Instale com: npm install -g @anthropic-ai/claude-code');
  line(info, '  (ou pelo instalador oficial em https://docs.claude.com/en/docs/claude-code)');
  line(info, 'Depois rode `claude` uma vez e faca o login. O JARVIS usa esse login — nao precisa de chave de API.');
}

// --- ~/.claude.json and MCP servers --------------------------------------
const claudeJsonPath = join(homedir(), '.claude.json');
let mcpCount = 0;
try {
  const raw = readFileSync(claudeJsonPath, 'utf8');
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const servers = parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers ? parsed.mcpServers : {};
  mcpCount = Object.keys(servers).length;
  if (mcpCount > 0) {
    line(tick, `~/.claude.json encontrado com ${mcpCount} servidor(es) MCP configurado(s).`);
  } else {
    line(info, '~/.claude.json encontrado, sem servidores MCP. Tudo bem: o JARVIS responde e controla a propria interface mesmo assim.');
  }
} catch {
  line(info, '~/.claude.json ainda nao existe. Ele aparece depois que voce roda `claude` e faz login.');
}

// --- ElevenLabs key (env or the elevenlabs MCP entry) --------------------
function findElevenLabsKey() {
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY.trim()) {
    return 'environment (ELEVENLABS_API_KEY)';
  }
  try {
    const raw = readFileSync(claudeJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    const servers = parsed && parsed.mcpServers ? parsed.mcpServers : {};
    const el = servers.elevenlabs;
    const env = el && el.env ? el.env : {};
    if (env.ELEVENLABS_API_KEY && String(env.ELEVENLABS_API_KEY).trim()) {
      return 'the elevenlabs MCP server in ~/.claude.json';
    }
  } catch {
    // ignore — no key discoverable
  }
  return null;
}

const elSource = findElevenLabsKey();
if (elSource) {
  line(tick, `Voz premium disponivel — chave da ElevenLabs encontrada (${elSource}).`);
} else {
  line(info, 'Sem chave da ElevenLabs — o JARVIS vai usar a voz do proprio navegador (funciona normalmente).');
  line(info, '  Opcional: coloque a chave no arquivo elevenlabs.txt para uma voz e uma audicao melhores.');
}

// --- How to run ----------------------------------------------------------
console.log('');
console.log('Para usar o JARVIS, de dois cliques em INICIAR.bat.');
console.log('Depois clique em INICIALIZAR no Chrome e diga "Ei Jarvis".');
console.log('');

process.exit(0);
