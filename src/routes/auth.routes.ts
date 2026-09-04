import { Router } from "express";
import type { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma.js";
import rateLimit from "express-rate-limit";



const router: Router = Router();

const login_limiter = rateLimit({
  windowMs : 15 * 60 * 1000,
  max: 20,
  message: {message: "Demasiadas peticiones, intenta mas tarde"}
})


router.post("/login",login_limiter, async (req:Request, res:Response) =>{
  try {
    const {usuario,password} = req.body;

    if(!usuario || !password) {
      return res.status(400).json({message: "Usuario y contraseña son obligatorios"});
    }

    const user = await prisma.usuarios.findUnique({
      where: {
        usuario
      }
    });

    if (!user) {
      return res.status(401).json({message:"Usuario o contraseña incorrectos"});
    }

    if(user.bloqueado_hasta && user.bloqueado_hasta > new Date()) {
      return res.status(423).json({
        message: "Usuario bloqueado temporalmente",
        bloqueado_hasta: user.bloqueado_hasta
      });
    }

    if(user.estatus !== "ACTIVO") {
      return res.status(403).json({message:"El usuario no esta activo"});
    }

    const password_valida = await bcrypt.compare(password,user.pass);

    if(!password_valida) {
      const nuevos_intentos = user.intentos_fallidos +1;

      if(nuevos_intentos >= 5) {
        const bloqueado_hasta = new Date(
          Date.now() + 15 * 60 * 1000
        );

        await prisma.usuarios.update({
          where:{
            id: user.id
          },
          data: {
            intentos_fallidos: nuevos_intentos,
            bloqueado_hasta: bloqueado_hasta
          }
        });

        return res.status(423).json({message:"Demasiados intentos fallidos. Usario bloqueado durante 15 minutos"});
      }

      await prisma.usuarios.update({
        where: {
          id:user.id
        },
        data: {
          intentos_fallidos: nuevos_intentos
        }
      });

      return res.status(401).json({message:"Usuario o contraseña incorrectos"});
    }

    await prisma.usuarios.update({
      where: {
        id: user.id
      },
      data: {
        intentos_fallidos: 0,
        bloqueado_hasta: null,
        ultimo_login: new Date()
      }
    });

    const secret = process.env.JWT_SECRET;

    if(!secret) {
      throw new Error("JWT_SECRET no esta configurado");
    }

    const token = jwt.sign(
      {
        id:user.id,
        usuario: user.usuario,
        rol: user.rol,
        token_version: user.token_version
      },
      secret,
      {
        expiresIn: "8h"
      }
    );

    return res.status(200).json({
      message: "Login exitoso",
      token
    });
  } catch (error) {
    console.error(error);
    
    return res.status(500).json({message:"Error interno del servidor"});
  }
});

export default router;