import { PrismaClient } from "@prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

const adapter = new PrismaMariaDb({
  host: "localhost",
  user: "root",
  password: "root",
  database: "credimil1",
  port: 3306,
});

const prisma = new PrismaClient({
  adapter,
});

export default prisma;