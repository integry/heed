import { Buffer } from "node:buffer";
import { log } from "node:console";
import { createECDH } from "node:crypto";

const key = createECDH("prime256v1");
key.generateKeys();
const privateKey = Buffer.alloc(32);
const scalar = key.getPrivateKey();
scalar.copy(privateKey, privateKey.length - scalar.length);

log(`VAPID_PUBLIC_KEY=${key.getPublicKey().toString("base64url")}`);
log(`VAPID_PRIVATE_KEY=${privateKey.toString("base64url")}`);
