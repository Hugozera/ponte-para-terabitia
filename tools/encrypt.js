"use strict";

/* ============================================================
   Cifra o conteudo do livro para publicacao.

   Uso:
     node tools/encrypt.js <frase> [frase-alternativa...]

   Le  livro_ligia/conteudo.privado.json  (NUNCA commitado)
   Gera livro_ligia/conteudo.enc.json      (este vai pro site)

   Esquema: AES-256-GCM. Uma chave aleatoria cifra o conteudo;
   essa chave e guardada "embrulhada" uma vez para cada frase
   aceita (PBKDF2-SHA256). Sem a frase, nada e legivel.
   ============================================================ */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ITERATIONS = 310000;
const ROOT = path.join(__dirname, "..");
const IN_FILE = path.join(ROOT, "livro_ligia", "conteudo.privado.json");
const OUT_FILE = path.join(ROOT, "livro_ligia", "conteudo.enc.json");

function normalize(text) {
  const decomposed = text.toLowerCase().normalize("NFD");
  let out = "";
  for (let i = 0; i < decomposed.length; i += 1) {
    const code = decomposed.charCodeAt(i);
    if (code >= 768 && code <= 879) continue; // acentos soltos pelo NFD
    const ch = decomposed[i];
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) out += ch;
  }
  return out;
}

function gcmEncrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, data: Buffer.concat([data, tag]) };
}

const phrases = process.argv.slice(2).map(normalize).filter(Boolean);
if (phrases.length === 0) {
  console.error("Informe pelo menos uma frase: node tools/encrypt.js <frase>");
  process.exit(1);
}

const content = fs.readFileSync(IN_FILE);
JSON.parse(content); // valida antes de cifrar

const contentKey = crypto.randomBytes(32);
const body = gcmEncrypt(contentKey, content);

const wraps = phrases.map((phrase) => {
  const salt = crypto.randomBytes(16);
  const kek = crypto.pbkdf2Sync(phrase, salt, ITERATIONS, 32, "sha256");
  const wrap = gcmEncrypt(kek, contentKey);
  return {
    salt: salt.toString("base64"),
    iv: wrap.iv.toString("base64"),
    data: wrap.data.toString("base64")
  };
});

fs.writeFileSync(OUT_FILE, JSON.stringify({
  v: 1,
  iter: ITERATIONS,
  wraps,
  iv: body.iv.toString("base64"),
  data: body.data.toString("base64")
}));

console.log(`ok: ${path.relative(ROOT, OUT_FILE)} gerado (${wraps.length} frase(s) aceita(s))`);
