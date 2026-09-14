import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { roleAtLeast, type Role } from "./users.js";

export type JwtUser = { sub: string; role: Role; uid: string };

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(import("@fastify/jwt"), {
    secret: config.jwtSecret,
    sign: { expiresIn: "12h" },
  });

  app.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
    }
  );

  app.decorate("requireRole", (minimum: Role) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const role = request.user?.role;
      if (!role || !roleAtLeast(role, minimum)) {
        return reply.code(403).send({ error: "Forbidden — insufficient role" });
      }
    };
  });
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      minimum: Role
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function actorOf(request: FastifyRequest): string {
  return request.user?.sub ?? "anonymous";
}
