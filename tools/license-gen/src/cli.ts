#!/usr/bin/env node
/**
 * Flexible Vixel license generator.
 *
 * Usage:
 *   npm run license:gen -- --private-key ./license.priv.pem \
 *     --customer "Acme Corp" --max-cameras 47 --max-storage 3 \
 *     --features s3,sftp,local-storage --days 365
 *
 * Or JSON entitlements file:
 *   npm run license:gen -- --private-key ./key.pem --from entitlements.json
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";

const Entitlements = z.object({
  licenseId: z.string().default(() => crypto.randomUUID()),
  customer: z.string(),
  issuedAt: z.string().default(() => new Date().toISOString()),
  expiresAt: z.string().nullable().default(null),
  maxCameras: z.number().int().min(1),
  maxStorageTargets: z.number().int().min(1).default(10),
  maxConcurrentJobs: z.number().int().min(1).default(4),
  features: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): never {
  console.log(`Vixel license generator

Required:
  --private-key <pem-file>   ECDSA P-256 private key (PKCS8 PEM)
  --customer <name>

Limits (any integers — fully flexible):
  --max-cameras <n>
  --max-storage <n>
  --max-jobs <n>
  --features <csv>           e.g. s3,sftp,local-storage,api,*
  --days <n>                 expiry in days (omit for never)
  --notes <text>
  --license-id <id>

Or:
  --from <json-file>         full entitlements JSON

Also:
  --gen-keypair <prefix>     write prefix.priv.pem + prefix.pub.pem and exit
`);
  process.exit(1);
}

function main() {
  if (flag("--help") || flag("-h")) usage();

  const gen = arg("--gen-keypair");
  if (gen) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
    const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    fs.writeFileSync(`${gen}.pub.pem`, pub);
    fs.writeFileSync(`${gen}.priv.pem`, priv, { mode: 0o600 });
    console.log(`Wrote ${gen}.pub.pem and ${gen}.priv.pem`);
    console.log("Set VIXEL_LICENSE_PUBLIC_KEY to the public PEM (use \\n for newlines in .env).");
    return;
  }

  const keyPath = arg("--private-key");
  if (!keyPath) usage();
  const privateKeyPem = fs.readFileSync(keyPath, "utf8");

  let raw: unknown;
  const from = arg("--from");
  if (from) {
    raw = JSON.parse(fs.readFileSync(from, "utf8"));
  } else {
    const customer = arg("--customer");
    const maxCameras = Number(arg("--max-cameras") ?? "0");
    if (!customer || !maxCameras) usage();
    const days = arg("--days");
    const features = (arg("--features") ?? "local-storage")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    raw = {
      licenseId: arg("--license-id"),
      customer,
      maxCameras,
      maxStorageTargets: Number(arg("--max-storage") ?? 10),
      maxConcurrentJobs: Number(arg("--max-jobs") ?? 4),
      features,
      notes: arg("--notes"),
      expiresAt: days
        ? new Date(Date.now() + Number(days) * 86400000).toISOString()
        : null,
    };
  }

  const entitlements = Entitlements.parse(raw);
  const payload = Buffer.from(JSON.stringify(entitlements)).toString("base64url");
  const sign = crypto.createSign("SHA256");
  sign.update(payload);
  sign.end();
  const signature = sign.sign(privateKeyPem, "base64url");
  const license = `VIXEL1.${payload}.${signature}`;
  console.log(license);
  console.error("\nEntitlements:", JSON.stringify(entitlements, null, 2));
}

main();
