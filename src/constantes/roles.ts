export const ROLES = {
  ADMINISTRADOR: "administrador",
  GERENTE_ZONA: "gerente_zona",
  PROMOTOR: "promotor",
  AUDITOR: "auditor",
  LECTURA: "lectura",
} as const;

export type Rol = typeof ROLES[keyof typeof ROLES];