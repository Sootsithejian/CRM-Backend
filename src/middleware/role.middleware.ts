import type { Response,NextFunction } from "express";
import type { AuthRequest } from "./auth.middleware.js";



export const requireRole = (...roles_permitidos: string[]) =>{
    return (req: AuthRequest, res: Response, next: NextFunction) =>{
        if(!req.user) {
            return res.status(401).json({message:"No autenticado"});
        }

        if (!roles_permitidos.includes(req.user.rol)) {
            return res.status(403).json({message:"No tienes permiso para realizar esta accion"});
        }
        next();
    };
};