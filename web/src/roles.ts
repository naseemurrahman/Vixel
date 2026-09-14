export type Role = "admin" | "operator" | "viewer";

export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: Role;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export function roleAtLeast(role: Role | undefined, minimum: Role): boolean {
  if (!role) return false;
  return RANK[role] >= RANK[minimum];
}
