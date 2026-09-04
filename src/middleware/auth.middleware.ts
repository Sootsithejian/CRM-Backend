import type { Request, Response, NextFunction } from "express";
import  jwt  from "jsonwebtoken";
import prisma from "../lib/prisma.js";

interface AuthPayload {
  id:number;
  usuario: string;
  rol: string;
  token_version: number;
}

export interface AuthRequest extends Request {
  user?: AuthPayload;
}

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;

    if(!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({message:"Token no proporcionado"});
    }
    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({message:"Token no proporcionado"})
    }
    const secret = process.env.JWT_SECRET;

    if(!secret) {
      throw new Error("JWT_SECRET no esta configurado");
    }

    const decoded = jwt.verify(token, secret) as unknown as AuthPayload;

    const user = await prisma.usuarios.findUnique({
      where: {
        id: decoded.id
      }
    });

    if(!user) {
      return res.status(401).json({message:"Usuario no encontrado"});
    }

    if(user.estatus !== "ACTIVO") {
      return res.status(403).json({message:"Usuario inactivo"});
    }

    if (user.token_version !== decoded.token_version) {
      return res.status(401).json({message:"Token invalido"});
    }

    req.user = decoded;

    next();
  } catch (error) {
    
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({message:"Token expirado"});
    }

    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({message:"Token invalido"});
    }

    console.error(error);

    return res.status(500).json({message:"Error interno del servidor"});
  }
}