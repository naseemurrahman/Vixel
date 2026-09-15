import { config } from "./config.js";
import { db, nowIso } from "./db.js";
import { hashPassword } from "./users.js";

const password = process.env.VIXEL_RESET_ADMIN_PASSWORD;
const username = (process.env.VIXEL_RESET_ADMIN_USER ?? config.adminUser).trim();

if (!password || password.length < 16) {
  throw new Error("Set VIXEL_RESET_ADMIN_PASSWORD to a new password of at least 16 characters");
}

const updated = db
  .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ? AND role = 'admin' AND active = 1")
  .run(hashPassword(password), nowIso(), username);

if (updated.changes !== 1) {
  throw new Error("No active administrator with that username was found; password was not changed");
}

console.log(`Password reset for administrator ${username}. Remove VIXEL_RESET_ADMIN_PASSWORD from your shell history.`);
