import { Router } from "express";
import type { Request, Response } from "express";
import bcrypt from "bcrypt";
import prisma from "../lib/prisma.js";
import { authMiddleware, type AuthRequest } from "../middleware/auth.middleware.js";
import { ROLES } from "../constantes/roles.js";
import { requireRole } from "../middleware/role.middleware.js";

const router: Router = Router();


async function obtenerZonaDelUsuario(id: number): Promise<string | null> {
  const usuario = await prisma.usuarios.findUnique({
    where: { id },
    select: { zona: true }
  });
  return usuario?.zona ?? null;
}

router.post("/usuarios", authMiddleware, requireRole(ROLES.ADMINISTRADOR, ROLES.GERENTE_ZONA), async (req: AuthRequest, res: Response) => {
  try {
    const {
      nombre,
      usuario,
      password,
      puesto,
      id_sucursal,
      id_sector,
      zona,
      estatus,
      ine,
      sueldo,
      gas,
      calle,
      numero,
      colonia,
      fecha_contratacion,
      telefono,
      nombre_aval,
      calle_aval,
      exterior_aval,
      interior_aval,
      colonia_aval,
      ciudad_aval,
      porcentaje,
      cajaAhorro,
      fecha_caja,
      telefono_aval,
      expediente,
      fechanac,
      categoria,
      curp
    } = req.body;

    if (!nombre || !usuario || !password) {
      return res.status(400).json({ message: "Nombre, usuario y contraseña son obligatorios" });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: "La contraseña debe de tener al menos 8 caracteres" });
    }

    const existente = await prisma.usuarios.findUnique({
      where: { usuario }
    });

    if (existente) {
      return res.status(409).json({ message: "Este nombre de usuario ya esta en uso" });
    }

    // Un Gerente de Zona solo puede crear usuarios dentro de su propia zona.
    if (req.user!.rol === ROLES.GERENTE_ZONA) {
      const zonaGerente = await obtenerZonaDelUsuario(req.user!.id);

      if (!zonaGerente) {
        return res.status(403).json({ message: "Tu usuario no tiene una zona asignada" });
      }

      if (zona !== zonaGerente) {
        return res.status(403).json({ message: "No puedes crear usuarios fuera de tu zona" });
      }
    }

    const password_hash = await bcrypt.hash(password, 10);

    const nuevo_usuario = await prisma.usuarios.create({
      data: {
        fechahora: new Date(),
        nombre,
        usuario,
        pass: password_hash,
        puesto,
        id_sucursal,
        id_sector,
        zona,
        estatus: estatus ?? "ACTIVO",
        ine,
        sueldo: sueldo ?? 0,
        gas: gas ?? 0,
        calle,
        numero,
        colonia,
        fecha_contratacion: fecha_contratacion ? new Date(fecha_contratacion) : null,
        telefono,
        nombre_aval,
        calle_aval,
        exterior_aval,
        interior_aval,
        colonia_aval,
        ciudad_aval,
        porcentaje,
        cajaAhorro,
        fecha_caja: fecha_caja ? new Date(fecha_caja) : null,
        telefono_aval,
        expediente,
        fechanac: fechanac ? new Date(fechanac) : null,
        categoria,
        curp,
        token_version: 0,
        intentos_fallidos: 0
      }
    });

    const { pass, ...usuarios_sin_password } = nuevo_usuario;

    return res.status(201).json({
      message: "Usuario creado correctamente",
      usuario: usuarios_sin_password
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error interno del servidor" });
  }
});

/* 
    Listado de usuarios. Admin/Auditor/Lectura ven todos (con filtros
    opcionales). Gerente de Zona solo ve los de su propia zona. Promotor
    no tiene acceso a este endpoint.
*/
router.get("/usuarios", authMiddleware, requireRole(ROLES.ADMINISTRADOR, ROLES.GERENTE_ZONA, ROLES.AUDITOR, ROLES.LECTURA), async (req: AuthRequest, res: Response) => {
  try {
    const { estatus, zona, search } = req.query;

    const where: any = {};

    if (req.user!.rol === ROLES.GERENTE_ZONA) {
      const zonaGerente = await obtenerZonaDelUsuario(req.user!.id);

      if (!zonaGerente) {
        return res.status(403).json({ message: "Tu usuario no tiene una zona asignada" });
      }

      where.zona = zonaGerente;
    } else if (zona) {
      where.zona = String(zona);
    }

    if (estatus) {
      where.estatus = String(estatus);
    }

    if (search) {
      where.OR = [
        { nombre: { contains: String(search) } },
        { usuario: { contains: String(search) } }
      ];
    }

    const usuarios = await prisma.usuarios.findMany({
      where,
      orderBy: { id: "asc" },
      select: {
        id: true,
        nombre: true,
        usuario: true,
        puesto: true,
        rol: true,
        id_sucursal: true,
        zona: true,
        estatus: true,
        sueldo: true,
        fecha_contratacion: true,
        telefono: true,
        categoria: true
      }
    });

    return res.status(200).json({ usuarios });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error interno del servidor" });
  }
});

/**Conteo de usuaiors, devuelve solo números */

router.get("/usuarios/conteo", authMiddleware, requireRole(ROLES.ADMINISTRADOR,ROLES.GERENTE_ZONA,ROLES.AUDITOR,ROLES.PROMOTOR,ROLES.LECTURA), async (req: AuthRequest, res:Response) => {
  try{
    const { estatus, zona } = req.query;

    const where: any = {};

    if (req.user!.rol === ROLES.GERENTE_ZONA) {
      const zonaGerente = await obtenerZonaDelUsuario(req.user!.id);

      if(!zonaGerente) {
        return res.status(403).json({message: "Tu usuario no tiene una zona asignada"})
      }
      where.zona = zonaGerente;
    } else if (zona) {
      where.zona = String(zona);
    }
    
    if (estatus) {
      where.estatus = String(estatus);
    }

    const [total, activos, inactivos] = await Promise.all([
      prisma.usuarios.count({ where }),
      prisma.usuarios.count ({ where: { ...where, estatus: "ACTIVO"}}),
      prisma.usuarios.count({ where: { ...where, estatus: {not: "ACTIVO"}}})
    ]);
    
    return res.status(200).json({total, activos,inactivos});
  } catch (error) {
    console.error(error);
    return res.status(500).json({message:"Error interno del servidor"})
  }
});

// Detalle de un usuario puntual, con el mismo alcance por zona que el listado.
router.get("/usuarios/:id", authMiddleware, requireRole(ROLES.ADMINISTRADOR, ROLES.GERENTE_ZONA, ROLES.AUDITOR, ROLES.LECTURA), async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);

    const usuario = await prisma.usuarios.findUnique({
      where: { id },
      select: {
        id: true,
        nombre: true,
        usuario: true,
        puesto: true,
        rol: true,
        id_sucursal: true,
        id_sector: true,
        zona: true,
        estatus: true,
        ine: true,
        sueldo: true,
        gas: true,
        calle: true,
        numero: true,
        colonia: true,
        motivo_baja: true,
        fecha_contratacion: true,
        fecha_bajaempleado: true,
        telefono: true,
        categoria: true,
        curp: true,
        ultimo_login: true
      }
    });

    if (!usuario) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    if (req.user!.rol === ROLES.GERENTE_ZONA) {
      const zonaGerente = await obtenerZonaDelUsuario(req.user!.id);

      if (!zonaGerente || usuario.zona !== zonaGerente) {
        return res.status(403).json({ message: "No puedes ver usuarios fuera de tu zona" });
      }
    }

    return res.status(200).json({ usuario });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error interno del servidor" });
  }
});

// Baja lógica: nunca se borra la fila, solo se marca ACTIVO -> BAJA

router.patch("/usuarios/:id/baja", authMiddleware, requireRole(ROLES.ADMINISTRADOR, ROLES.GERENTE_ZONA), async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { motivo_baja } = req.body;

    const usuario = await prisma.usuarios.findUnique({ where: { id } });

    if (!usuario) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    if (usuario.estatus === "BAJA") {
      return res.status(409).json({ message: "El usuario ya esta dado de baja" });
    }

    if (req.user!.rol === ROLES.GERENTE_ZONA) {
      const zonaGerente = await obtenerZonaDelUsuario(req.user!.id);

      if (!zonaGerente || usuario.zona !== zonaGerente) {
        return res.status(403).json({ message: "No puedes dar de baja usuarios fuera de tu zona" });
      }
    }

    await prisma.usuarios.update({
      where: { id },
      data: {
        estatus: "BAJA",
        motivo_baja: motivo_baja ?? null,
        fecha_bajaempleado: new Date(),
        token_version: { increment: 1 } 
      }
    });

    return res.status(200).json({ message: "Usuario dado de baja correctamente" });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error interno del servidor" });
  }
});

router.put("/usuarios/:id/password", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { password } = req.body;

    const es_propio = req.user!.id;
    const es_admin = req.user!.rol === ROLES.ADMINISTRADOR;
    
    if(!es_propio && !es_admin) {
      return res.status(400).json({message:"No puedes cambiar la contraseña de este usuario"})
    }


    if (req.user!.id !== id) {
      return res.status(403).json({ message: "No puedes cambiar la contraseña de otro usuario" });
    }

    if (!password) {
      return res.status(400).json({ message: "La contraseña es obligatoria" });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: "La contraseña debe de tener minimo 8 caracteres" });
    }

    const user = await prisma.usuarios.findUnique({
      where: { id }
    });
    if (!user) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    await prisma.usuarios.update({
      where: { id },
      data: {
        pass: password_hash,
        token_version: { increment: 1 }
      }
    });

    return res.status(200).json({ message: "Contraseña actualizada correctamente" });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error interno del servidor" });
  }
});

router.get("/me", authMiddleware, async (req:AuthRequest, res:Response) => {
  const usuario = await prisma.usuarios.findUnique({
    where: {id: req.user!.id},
    select: {id:true, nombre:true, usuario:true, rol:true, zona:true, puesto:true}
  });
  return res.status(200).json({usuario});
});

export default router;