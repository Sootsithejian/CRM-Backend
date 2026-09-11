import { Router } from "express";

import type { Response } from "express";

import prisma from "../lib/prisma.js";

import { authMiddleware, type AuthRequest } from "../middleware/auth.middleware.js";

import { requireRole } from "../middleware/role.middleware.js";

import { ROLES } from "../constantes/roles.js";

import {

  MAX_CLIENTES_AVALADOS_POR_PERSONA,

  NUMERO_CLIENTE_INICIAL

} from "../constantes/clientes.js";

import { esCurpValida, normalizarBusqueda, normalizarCurp } from "../lib/texto.js";

const router: Router = Router();

/* Zona del usuario autenticado, 
duplicado del helper de usuarios.routes.ts: 
limpieza pendiente!!
 */
async function obtenerZonaDelUsuarioCliente(id:number): Promise<string | null > {
  const usuario = await prisma.usuarios.findUnique ({
    where:{id},
    select: {zona: true}
  });
  return usuario?.zona ?? null;
}

/*  Datos mínimos de una persona (sirve para el titular y para el aval). */

interface PersonaInput {

  curp: string;

  nombre: string;

  fecha_nac?: string;

  sexo?: string;

  rfc?: string;

  ocupacion?: string;

  estado_civil?: string;

  email?: string;

  tel_principal?: string;

  tel_2?: string;

  tel_3?: string;

}

interface DomicilioInput {

  calle: string;

  numero_ext?: string;

  numero_int?: string;

  colonia?: string;

  cp?: string;

  municipio?: string;

  estado?: string;

  entre_calles?: string;

  tipo_vivienda?: string;

}

/*  Valida los campos obligatorios de una persona.

    Devuelve el mensaje de error, o null si todo está bien.

*/

function validarPersona(p: PersonaInput | undefined, etiqueta: string): string | null {

  if (!p) return `Faltan los datos del ${etiqueta}`;

  if (!p.nombre || !p.nombre.trim()) return `El nombre del ${etiqueta} es obligatorio`;

  if (!p.curp || !p.curp.trim()) return `La CURP del ${etiqueta} es obligatoria`;

  if (!esCurpValida(p.curp)) return `La CURP del ${etiqueta} no tiene un formato válido`;

  return null;

}

/*  Busca una persona por CURP; si no existe, la crea.
*/

async function obtenerOCrearPersona(

  tx: any,

  datos: PersonaInput,

  usuarioAlta: string

) {

  const curp = normalizarCurp(datos.curp);

  const existente = await tx.personas.findFirst({ where: { curp } });

  if (existente) return existente;

  return tx.personas.create({

    data: {

      curp,

      nombre: datos.nombre.trim(),

      nombre_busq: normalizarBusqueda(datos.nombre),

      fecha_nac: datos.fecha_nac ? new Date(datos.fecha_nac) : null,

      sexo: datos.sexo ?? null,

      rfc: datos.rfc ?? null,

      ocupacion: datos.ocupacion ?? null,

      estado_civil: datos.estado_civil ?? null,

      email: datos.email ?? null,

      tel_principal: datos.tel_principal ?? null,

      tel_2: datos.tel_2 ?? null,

      tel_3: datos.tel_3 ?? null,

      usuario_alta: usuarioAlta

    }

  });

}

/*  Alta de cliente.
 
    Crea en una sola transacción: persona titular, domicilio, vínculo

    persona-domicilio, cliente (con folio) y las relaciones de aval.
 
    Reglas aplicadas:

      - CURP obligatoria y con formato válido (titular y avales)

      - CURP del titular no puede estar ya registrada como cliente

      - mínimo 1 aval, máximo 2

      - nadie puede avalarse a sí mismo

      - una persona no puede avalar a más de 2 clientes

      - ni el titular ni los avales pueden estar en lista negra activa

*/

router.post(

  "/clientes",

  authMiddleware,

  requireRole(ROLES.ADMINISTRADOR, ROLES.GERENTE_ZONA, ROLES.PROMOTOR),

  async (req: AuthRequest, res: Response) => {

    try {

      const { persona, domicilio, cliente, avales } = req.body as {

        persona?: PersonaInput;

        domicilio?: DomicilioInput;

        cliente?: { zona?: string; sector?: string; observaciones?: string };

        avales?: { persona: PersonaInput; domicilio?: DomicilioInput; parentesco?: string }[];

      };

      // ---- Validaciones de forma ----

      const errorTitular = validarPersona(persona, "titular");

      if (errorTitular) return res.status(400).json({ message: errorTitular });

      if (!domicilio?.calle || !domicilio.calle.trim()) {

        return res.status(400).json({ message: "La calle del domicilio es obligatoria" });

      }

      if (avales && avales.length > 2) {

        return res.status(400).json({ message: "Un cliente no puede tener más de dos avales" });

      }

      for (const aval of avales ?? []) {

        const errorAval = validarPersona(aval.persona, "aval");
        if (errorAval) return res.status(400).json({ message: errorAval });

      }

      const curpTitular = normalizarCurp(persona!.curp);

      const curpsAvales = (avales ??[]).map((a) => normalizarCurp(a.persona.curp));

      if (curpsAvales.includes(curpTitular)) {

        return res.status(400).json({ message: "El titular no puede ser su propio aval" });

      }

      if (curpsAvales.length === 2 && curpsAvales[0] === curpsAvales[1]) {

        return res.status(400).json({ message: "Los dos avales no pueden ser la misma persona" });

      }

      // ---- Lista negra (antes de escribir nada) ----

      const vetados = await prisma.lista_negra.findMany({

        where: {

          activa: true,

          persona: { curp: { in: [curpTitular, ...curpsAvales] } }

        },

        include: { persona: { select: { nombre: true, curp: true } } }

      });

      if (vetados.length > 0) {

        const nombres = vetados.map((v) => v.persona.nombre).join(", ");

        return res.status(409).json({

          message: `No se puede dar de alta: en lista negra (${nombres})`

        });

      }

      const usuarioAlta = req.user!.usuario;

      // ---- Transacción ----

      const resultado = await prisma.$transaction(async (tx) => {

        const personaTitular = await obtenerOCrearPersona(tx, persona!, usuarioAlta);

        // ¿Ya es cliente?

        const yaEsCliente = await tx.clientes.findUnique({

          where: { id_persona: personaTitular.id }

        });

        if (yaEsCliente) {

          throw Object.assign(

            new Error(`La CURP ${curpTitular} ya está registrada como cliente`),

            { statusHttp: 409 }

          );

        }

        // Domicilio del titular

        const domicilioCreado = await tx.domicilios.create({

          data: {

            calle: domicilio.calle.trim(),

            calle_busq: normalizarBusqueda(domicilio.calle),

            numero_ext: domicilio.numero_ext ?? null,

            numero_int: domicilio.numero_int ?? null,

            colonia: domicilio.colonia ?? null,

            cp: domicilio.cp ?? null,

            municipio: domicilio.municipio ?? null,

            estado: domicilio.estado ?? null,

            entre_calles: domicilio.entre_calles ?? null,

            tipo_vivienda: domicilio.tipo_vivienda ?? null

          }

        });

        await tx.persona_domicilio.create({

          data: {

            id_persona: personaTitular.id,

            id_domicilio: domicilioCreado.id,

            vigente: true

          }

        });

        // Folio: máximo actual + 1, o el inicial si la tabla está vacía.

        const ultimo = await tx.clientes.findFirst({

          orderBy: { numero_cliente: "desc" },

          select: { numero_cliente: true }

        });

        const numeroCliente = ultimo

          ? ultimo.numero_cliente + 1

          : NUMERO_CLIENTE_INICIAL;

        const clienteCreado = await tx.clientes.create({

          data: {

            id_persona: personaTitular.id,

            numero_cliente: numeroCliente,

            zona: cliente?.zona ?? null,

            sector: cliente?.sector ?? null,

            observaciones: cliente?.observaciones ?? null,

            usuario_alta: usuarioAlta

          }

        });

        // ---- Avales ----

        for (const aval of avales ?? []) {

          const personaAval = await obtenerOCrearPersona(tx, aval.persona, usuarioAlta);

          if (personaAval.id === personaTitular.id) {

            throw Object.assign(

              new Error("El titular no puede ser su propio aval"),

              { statusHttp: 400 }

            );

          }

          const avaladosActuales = await tx.relaciones_aval.count({

            where: { id_persona_aval: personaAval.id, vigente: true }

          });

          if (avaladosActuales >= MAX_CLIENTES_AVALADOS_POR_PERSONA) {

            throw Object.assign(

              new Error(

                `${personaAval.nombre} ya avala a ${MAX_CLIENTES_AVALADOS_POR_PERSONA} clientes`

              ),

              { statusHttp: 409 }

            );

          }

          if (aval.domicilio?.calle) {

            const domAval = await tx.domicilios.create({

              data: {

                calle: aval.domicilio.calle.trim(),

                calle_busq: normalizarBusqueda(aval.domicilio.calle),

                numero_ext: aval.domicilio.numero_ext ?? null,

                numero_int: aval.domicilio.numero_int ?? null,

                colonia: aval.domicilio.colonia ?? null,

                cp: aval.domicilio.cp ?? null,

                municipio: aval.domicilio.municipio ?? null,

                estado: aval.domicilio.estado ?? null,

                entre_calles: aval.domicilio.entre_calles ?? null,

                tipo_vivienda: aval.domicilio.tipo_vivienda ?? null

              }

            });

            await tx.persona_domicilio.create({

              data: {

                id_persona: personaAval.id,

                id_domicilio: domAval.id,

                vigente: true

              }

            });

          }

          // id_credito queda null: se amarra cuando exista el módulo

          // de créditos. El aval se captura desde el alta del cliente.

          await tx.relaciones_aval.create({

            data: {

              id_persona_aval: personaAval.id,

              id_cliente: clienteCreado.id,

              parentesco: aval.parentesco ?? null,

              vigente: true,

              usuario_alta: usuarioAlta

            }

          });

        }

        return { cliente: clienteCreado, persona: personaTitular };

      });

      return res.status(201).json({

        message: "Cliente registrado correctamente",

        cliente: {

          id: resultado.cliente.id,

          numero_cliente: resultado.cliente.numero_cliente,

          id_persona: resultado.persona.id,

          nombre: resultado.persona.nombre,

          curp: resultado.persona.curp

        }

      });

    } catch (error: any) {

      if (error?.statusHttp) {

        return res.status(error.statusHttp).json({ message: error.message });

      }

      console.error(error);

      return res.status(500).json({ message: "Error interno del servidor" });

    }

  }

);

/*  Búsqueda unificada de personas.
 
    Un solo endpoint para los cuatro criterios que pidieron:
      ?curp=...            CURP exacta
      ?numero_cliente=...  folio de negocio
      ?nombre=...          prefijo de nombre (usa nombre_busq)
      ?calle=...&numero=.. domicilio (usa calle_busq)
 
    Devuelve, por cada persona encontrada, QUÉ ROLES juega:
    es_cliente, es_aval, en_lista_negra. Ese es el corazón del
    requisito "si busco a alguien, dime si es cliente o aval, y
    si es aval, de qué cliente".
*/
router.get(
  "/personas/buscar",
  authMiddleware,
  requireRole(
    ROLES.ADMINISTRADOR,
    ROLES.GERENTE_ZONA,
    ROLES.PROMOTOR,
    ROLES.AUDITOR,
    ROLES.LECTURA
  ),
  async (req: AuthRequest, res: Response) => {
    try {
      const { curp, numero_cliente, nombre, calle, numero, colonia } = req.query;
 
      const where: any = {};
      let hayCriterio = false;
 
      if (curp) {
        where.curp = normalizarCurp(String(curp));
        hayCriterio = true;
      }
 
      if (numero_cliente) {
        const folio = Number(numero_cliente);
        if (Number.isNaN(folio)) {
          return res.status(400).json({ message: "El número de cliente debe ser numérico" });
        }
        where.cliente = { numero_cliente: folio };
        hayCriterio = true;
      }
 
      if (nombre) {
        // Prefijo, no "contiene": así MySQL puede usar el índice.
        where.nombre_busq = { startsWith: normalizarBusqueda(String(nombre)) };
        hayCriterio = true;
      }
 
      if (calle) {
        const filtroDom: any = { calle_busq: { startsWith: normalizarBusqueda(String(calle)) } };
        if (numero) filtroDom.numero_ext = String(numero).trim();
        if (colonia) filtroDom.colonia = { contains: String(colonia).trim() };
 
        where.domicilios = { some: { vigente: true, domicilio: filtroDom } };
        hayCriterio = true;
      }
 
      if (!hayCriterio) {
        return res.status(400).json({
          message: "Indica al menos un criterio: curp, numero_cliente, nombre o calle"
        });
      }
 
      const personas = await prisma.personas.findMany({
        where,
        take: 50,
        orderBy: { nombre_busq: "asc" },
        select: {
          id: true,
          curp: true,
          nombre: true,
          fecha_nac: true,
          tel_principal: true,
          cliente: {
            select: {
              id: true,
              numero_cliente: true,
              zona: true,
              sector: true,
              estatus: true
            }
          },
          domicilios: {
            where: { vigente: true },
            select: {
              domicilio: {
                select: {
                  calle: true,
                  numero_ext: true,
                  numero_int: true,
                  colonia: true,
                  cp: true,
                  municipio: true
                }
              }
            }
          },
          // A quiénes avala esta persona
          avala_a: {
            where: { vigente: true },
            select: {
              id: true,
              parentesco: true,
              cliente: {
                select: {
                  id: true,
                  numero_cliente: true,
                  persona: { select: { id: true, nombre: true, curp: true } }
                }
              }
            }
          },
          lista_negra: {
            where: { activa: true },
            select: { id: true, motivo: true, fecha_alta: true }
          }
        }
      });
 
      // Aplana la respuesta a algo que la UI pueda pintar directo.
      const resultados = personas.map((p) => ({
        id: p.id,
        curp: p.curp,
        nombre: p.nombre,
        fecha_nac: p.fecha_nac,
        telefono: p.tel_principal,
 
        es_cliente: p.cliente !== null,
        es_aval: p.avala_a.length > 0,
        en_lista_negra: p.lista_negra.length > 0,
 
        cliente: p.cliente,
 
        domicilios: p.domicilios.map((d) => d.domicilio),
 
        avala_a: p.avala_a.map((r) => ({
          id_relacion: r.id,
          parentesco: r.parentesco,
          id_cliente: r.cliente.id,
          numero_cliente: r.cliente.numero_cliente,
          nombre_cliente: r.cliente.persona.nombre,
          curp_cliente: r.cliente.persona.curp
        })),
 
        lista_negra: p.lista_negra[0] ?? null
      }));
 
      return res.status(200).json({
        total: resultados.length,
        limitado: resultados.length === 50,
        personas: resultados
      });
 
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: "Error interno del servidor" });
    }
  }
);

/*  Listado paginado de clientes.
 
    Filtros: ?zona= ?sector= ?estatus= ?search=

    Paginación: ?pagina=1 ?limite=25
 
    `search` busca por nombre (prefijo), CURP o folio en una sola

    caja de texto: es lo que la UI necesita para su buscador rápido.
 
    El gerente_zona queda limitado a su zona.

*/

router.get(

  "/clientes",

  authMiddleware,

  requireRole(

    ROLES.ADMINISTRADOR,

    ROLES.GERENTE_ZONA,

    ROLES.PROMOTOR,

    ROLES.AUDITOR,

    ROLES.LECTURA

  ),

  async (req: AuthRequest, res: Response) => {

    try {

      const { zona, sector, estatus, search } = req.query;
 
      const pagina = Math.max(1, Number(req.query.pagina) || 1);

      const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 25));
 
      const where: any = {};
 
      // Alcance por zona.

      if (req.user!.rol === ROLES.GERENTE_ZONA) {

        const zonaGerente = await obtenerZonaDelUsuarioCliente(req.user!.id);

        if (!zonaGerente) {

          return res.status(403).json({ message: "Tu usuario no tiene una zona asignada" });

        }

        where.zona = zonaGerente;

      } else if (zona) {

        where.zona = String(zona);

      }
 
      if (sector) where.sector = String(sector);

      if (estatus) where.estatus = String(estatus);
 
      if (search) {

        const texto = String(search).trim();

        const comoNumero = Number(texto);
 
        const condiciones: any[] = [

          { persona: { nombre_busq: { startsWith: normalizarBusqueda(texto) } } },

          { persona: { curp: normalizarCurp(texto) } }

        ];
 
        if (!Number.isNaN(comoNumero)) {

          condiciones.push({ numero_cliente: comoNumero });

        }
 
        where.OR = condiciones;

      }
 
      const [total, clientes] = await Promise.all([

        prisma.clientes.count({ where }),

        prisma.clientes.findMany({

          where,

          skip: (pagina - 1) * limite,

          take: limite,

          orderBy: { numero_cliente: "desc" },

          include: {

            persona: {

              select: {

                id: true,

                nombre: true,

                curp: true,

                tel_principal: true,

                lista_negra: { where: { activa: true }, select: { id: true } },

                domicilios: {

                  where: { vigente: true },

                  take: 1,

                  select: {

                    domicilio: {

                      select: {

                        calle: true,

                        numero_ext: true,

                        colonia: true

                      }

                    }

                  }

                }

              }

            },

            _count: { select: { avales: { where: { vigente: true } } } }

          }

        })

      ]);
 
      return res.status(200).json({

        total,

        pagina,

        limite,

        paginas: Math.ceil(total / limite),

        clientes: clientes.map((c) => ({

          id: c.id,

          numero_cliente: c.numero_cliente,

          nombre: c.persona.nombre,

          curp: c.persona.curp,

          telefono: c.persona.tel_principal,

          zona: c.zona,

          sector: c.sector,

          estatus: c.estatus,

          color: c.color,

          en_lista_negra: c.persona.lista_negra.length > 0,

          total_avales: c._count.avales,

          domicilio: c.persona.domicilios[0]?.domicilio ?? null,

          fecha_alta: c.fecha_alta,

          observaciones: c.observaciones

        }))

      });
 
    } catch (error) {

      console.error(error);

      return res.status(500).json({ message: "Error interno del servidor" });

    }

  }

);

/*  Catálogo de zonas y sectores.

    No hay tablas de catálogo en la base, así que se derivan de los

    valores capturados. Cuando exista un catálogo formal, esto cambia.

*/

router.get(

  "/clientes/catalogos",

  authMiddleware,

  async (_req: AuthRequest, res: Response) => {

    try {

      const [zonas, sectores] = await Promise.all([

        prisma.clientes.findMany({

          where: { zona: { not: null } },

          distinct: ["zona"],

          select: { zona: true },

          orderBy: { zona: "asc" }

        }),

        prisma.clientes.findMany({

          where: { sector: { not: null } },

          distinct: ["sector"],

          select: { sector: true },

          orderBy: { sector: "asc" }

        })

      ]);
 
      return res.status(200).json({

        zonas: zonas.map((z) => z.zona),

        sectores: sectores.map((s) => s.sector)

      });

    } catch (error) {

      console.error(error);

      return res.status(500).json({ message: "Error interno del servidor" });

    }

  }

);
 
 
/*  Detalle completo de un cliente.
 
    Acepta el id interno o el folio de negocio:

      GET /api/clientes/23500?por=numero

      GET /api/clientes/1
 
    El gerente_zona solo ve clientes de su zona, igual que en usuarios.

*/

router.get(

  "/clientes/:id",

  authMiddleware,

  requireRole(

    ROLES.ADMINISTRADOR,

    ROLES.GERENTE_ZONA,

    ROLES.PROMOTOR,

    ROLES.AUDITOR,

    ROLES.LECTURA

  ),

  async (req: AuthRequest, res: Response) => {

    try {

      const valor = Number(req.params.id);

      if (Number.isNaN(valor)) {

        return res.status(400).json({ message: "Identificador inválido" });

      }
 
      const porFolio = req.query.por === "numero";
 
      const cliente = await prisma.clientes.findUnique({

        where: porFolio ? { numero_cliente: valor } : { id: valor },

        include: {

          persona: {

            include: {

              domicilios: {

                where: { vigente: true },

                include: { domicilio: true }

              },

              lista_negra: { where: { activa: true } },

              // Otros clientes a los que ESTE cliente avala.

              avala_a: {

                where: { vigente: true },

                include: {

                  cliente: {

                    include: { persona: { select: { id: true, nombre: true, curp: true } } }

                  }

                }

              }

            }

          },

          // Quiénes avalan a este cliente.

          avales: {

            where: { vigente: true },

            include: {

              aval: {

                include: {

                  domicilios: {

                    where: { vigente: true },

                    include: { domicilio: true }

                  },

                  lista_negra: { where: { activa: true } }

                }

              }

            }

          }

        }

      });
 
      if (!cliente) {

        return res.status(404).json({ message: "Cliente no encontrado" });

      }
 
      // Alcance por zona para el gerente.

      if (req.user!.rol === ROLES.GERENTE_ZONA) {

        const zonaGerente = await obtenerZonaDelUsuarioCliente(req.user!.id);

        if (!zonaGerente) {

          return res.status(403).json({ message: "Tu usuario no tiene una zona asignada" });

        }

        if (cliente.zona !== zonaGerente) {

          return res.status(403).json({ message: "Este cliente no pertenece a tu zona" });

        }

      }
 
      return res.status(200).json({

        cliente: {

          id: cliente.id,

          numero_cliente: cliente.numero_cliente,

          zona: cliente.zona,

          sector: cliente.sector,

          estatus: cliente.estatus,

          color: cliente.color,

          observaciones: cliente.observaciones,

          fecha_alta: cliente.fecha_alta,

          usuario_alta: cliente.usuario_alta

        },
 
        persona: {

          id: cliente.persona.id,

          curp: cliente.persona.curp,

          nombre: cliente.persona.nombre,

          fecha_nac: cliente.persona.fecha_nac,

          sexo: cliente.persona.sexo,

          rfc: cliente.persona.rfc,

          ocupacion: cliente.persona.ocupacion,

          estado_civil: cliente.persona.estado_civil,

          email: cliente.persona.email,

          tel_principal: cliente.persona.tel_principal,

          tel_2: cliente.persona.tel_2,

          tel_3: cliente.persona.tel_3,

          en_lista_negra: cliente.persona.lista_negra.length > 0

        },
 
        domicilios: cliente.persona.domicilios.map((d) => d.domicilio),
 
        avales: cliente.avales.map((r) => ({

          id_relacion: r.id,

          parentesco: r.parentesco,

          fecha_inicio: r.fecha_inicio,

          id_credito: r.id_credito,

          persona: {

            id: r.aval.id,

            curp: r.aval.curp,

            nombre: r.aval.nombre,

            tel_principal: r.aval.tel_principal,

            en_lista_negra: r.aval.lista_negra.length > 0

          },

          domicilios: r.aval.domicilios.map((d) => d.domicilio)

        })),
 
        // Este cliente, en su faceta de aval de otros.

        avala_a: cliente.persona.avala_a.map((r) => ({

          id_relacion: r.id,

          parentesco: r.parentesco,

          id_cliente: r.cliente.id,

          numero_cliente: r.cliente.numero_cliente,

          nombre: r.cliente.persona.nombre,

          curp: r.cliente.persona.curp

        }))

      });
 
    } catch (error) {

      console.error(error);

      return res.status(500).json({ message: "Error interno del servidor" });

    }

  }

);

/* Alta en lista negra.
  Apunta a la persona, no al cliente: asi se puede vetar a alguien que nunca ha sido cliente pero si aval.
  
  Efecto: Post a /api/cliente rechaza con 409 a cualquier persona vetada ya sea como titular o como aval
 */

router.post("/lista-negra", authMiddleware, requireRole(ROLES.ADMINISTRADOR, ROLES.GERENTE_ZONA),
async (req: AuthRequest, res: Response) => {
  try {
    const { id_persona, curp, motivo} = req.body as {
      id_persona?: number;
      curp?: string;
      motivo?: string;
    };


    if (!motivo || !motivo.trim()) {
      return res.status(400).json({ message: "El motivo es obligatorio"});
    }
    
    const curpLimpia = curp?.trim();

    if (!id_persona && !curpLimpia) {
      return res.status(400).json({ message: "Indica id_persona o curp"});
    }

    const persona = id_persona
      ? await prisma.personas.findUnique({
        where: {id: id_persona}
      })
      : await prisma.personas.findFirst({
        where: {curp: normalizarCurp(curpLimpia!)}
      });

      if (!persona) {
        return res.status(404).json({ message: "Persona no encontrada"});
      }

      const yaVetada = await prisma.lista_negra.findFirst({
        where: { id_persona: persona.id, activa: true}
      });

      if (yaVetada) {
        return res.status(409).json({
          message: `${persona.nombre} ya está en lista negra`
        });
      }

      const registro = await prisma.lista_negra.create ({
        data: {
          id_persona: persona.id,
          motivo: motivo.trim(),
          usuario_alta: req.user!.usuario
        }
      });

      return res.status(200).json({
        message: "Persona agregada a lista negra",
        registro: {
          id: registro.id,
          id_persona: persona.id,
          nombre: persona.nombre,
          curp: persona.curp,
          motivo: registro.motivo,
          fecha_alta: registro.fecha_alta
        }
      });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error interno del servidor"})
  }
});

/* Baja de lista negra. No borra el registro: lo marca como inactivo para mantener el historial */

router.patch("/lista-negra/:id/baja", authMiddleware, requireRole(ROLES.ADMINISTRADOR), async (req: AuthRequest, res:Response) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Id invalido"});
    }

    const {motivo_baja} = req.body as {motivo_baja?: string};

    if(!motivo_baja || !motivo_baja.trim()) {
      return res.status(400).json({ message: "El motivo de baja es obligatorio"});
    }

    const registro = await prisma.lista_negra.findUnique({ where: { id }});

    if (!registro) {
      return res.status(404).json({ message: "Registro no encontrado"});
    }

    if (!registro.activa) {
      return res.status(409).json({ message: "Este registro ya fue dado de baja"});
    }

    await prisma.lista_negra.update({
      where: {id},
      data: {
        activa: false,
        fecha_baja: new Date(),
        usuario_baja: req.user!.usuario,
        motivo_baja: motivo_baja.trim()
      }
    });

    return res.status(200).json({ message: "Persona retirada de lista negra"});
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error interno del servidor"})
  }
});

/* Consulta de lista negra ?activa=false para ver el historial */
router.get(

  "/lista-negra",

  authMiddleware,

  requireRole(

    ROLES.ADMINISTRADOR,

    ROLES.GERENTE_ZONA,

    ROLES.AUDITOR,

    ROLES.LECTURA

  ),

  async (req: AuthRequest, res: Response) => {

    try {

      const soloActivas = req.query.activa !== "false";

      const search = req.query.search ? String(req.query.search).trim() : "";
 
      const pagina = Math.max(1, Number(req.query.pagina) || 1);

      const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 25));
 
      const where: any = soloActivas ? { activa: true } : {};
 
      /*  Misma lógica de búsqueda que el listado de clientes:

          nombre (prefijo), CURP exacta, folio o teléfono.

      */

      if (search) {

        const comoNumero = Number(search);

        const condiciones: any[] = [

          { nombre_busq: { startsWith: normalizarBusqueda(search) } },

          { curp: normalizarCurp(search) },

          { tel_principal: { contains: search } }

        ];
 
        if (!Number.isNaN(comoNumero)) {

          condiciones.push({ cliente: { numero_cliente: comoNumero } });

        }
 
        where.persona = { OR: condiciones };

      }
 
      const [total, registros] = await Promise.all([

        prisma.lista_negra.count({ where }),

        prisma.lista_negra.findMany({

          where,

          skip: (pagina - 1) * limite,

          take: limite,

          orderBy: { fecha_alta: "desc" },

          include: {

            persona: {

              select: {

                id: true,

                nombre: true,

                curp: true,

                tel_principal: true,

                cliente: { select: { id: true, numero_cliente: true, zona: true, sector: true } }

              }

            }

          }

        })

      ]);
 
      return res.status(200).json({

        total,

        pagina,

        limite,

        paginas: Math.ceil(total / limite),

        registros: registros.map((r) => ({

          id: r.id,

          id_persona: r.persona.id,

          id_cliente: r.persona.cliente?.id ?? null,

          nombre: r.persona.nombre,

          curp: r.persona.curp,

          telefono: r.persona.tel_principal,

          numero_cliente: r.persona.cliente?.numero_cliente ?? null,

          zona: r.persona.cliente?.zona ?? null,

          sector: r.persona.cliente?.sector ?? null,

          motivo: r.motivo,

          activa: r.activa,

          fecha_alta: r.fecha_alta,

          usuario_alta: r.usuario_alta,

          fecha_baja: r.fecha_baja,

          usuario_baja: r.usuario_baja,

          motivo_baja: r.motivo_baja

        }))

      });
 
    } catch (error) {

      console.error(error);

      return res.status(500).json({ message: "Error interno del servidor" });

    }

  }

);
 

/*  Edición de cliente.
 
    Actualiza persona, domicilio vigente y datos del cliente. NO toca

    avales ni lista negra: esos tienen su propio flujo.
 
    La CURP se puede corregir (capturas mal escritas son comunes), pero

    se valida formato y que no la tenga ya otra persona.

*/

router.patch(

  "/clientes/:id",

  authMiddleware,

  requireRole(ROLES.ADMINISTRADOR, ROLES.GERENTE_ZONA, ROLES.PROMOTOR),

  async (req: AuthRequest, res: Response) => {

    try {

      const id = Number(req.params.id);

      if (Number.isNaN(id)) {

        return res.status(400).json({ message: "Identificador inválido" });

      }
 
      const { persona, domicilio, cliente } = req.body as {

        persona?: Partial<PersonaInput>;

        domicilio?: Partial<DomicilioInput>;

        cliente?: { zona?: string; sector?: string; estatus?: string; observaciones?: string };

      };
 
      const actual = await prisma.clientes.findUnique({

        where: { id },

        include: {

          persona: {

            include: { domicilios: { where: { vigente: true }, take: 1 } }

          }

        }

      });
 
      if (!actual) {

        return res.status(404).json({ message: "Cliente no encontrado" });

      }
 
      // Alcance por zona.

      if (req.user!.rol === ROLES.GERENTE_ZONA) {

        const zonaGerente = await obtenerZonaDelUsuarioCliente(req.user!.id);

        if (!zonaGerente) {

          return res.status(403).json({ message: "Tu usuario no tiene una zona asignada" });

        }

        if (actual.zona !== zonaGerente) {

          return res.status(403).json({ message: "Este cliente no pertenece a tu zona" });

        }

      }
 
      // CURP nueva: validar formato y que no esté tomada.

      let curpNueva: string | undefined;

      if (persona?.curp) {

        curpNueva = normalizarCurp(persona.curp);

        if (!esCurpValida(curpNueva)) {

          return res.status(400).json({ message: "La CURP no tiene un formato válido" });

        }

        if (curpNueva !== actual.persona.curp) {

          const ocupada = await prisma.personas.findFirst({

            where: { curp: curpNueva, id: { not: actual.id_persona } }

          });

          if (ocupada) {

            return res.status(409).json({

              message: `La CURP ${curpNueva} ya pertenece a ${ocupada.nombre}`

            });

          }

        }

      }
 
      await prisma.$transaction(async (tx) => {

        // --- Persona ---

        const datosPersona: any = {};

        if (curpNueva) datosPersona.curp = curpNueva;

        if (persona?.nombre) {

          datosPersona.nombre = persona.nombre.trim();

          datosPersona.nombre_busq = normalizarBusqueda(persona.nombre);

        }

        if (persona?.fecha_nac !== undefined) {

          datosPersona.fecha_nac = persona.fecha_nac ? new Date(persona.fecha_nac) : null;

        }

        for (const campo of ["sexo", "rfc", "ocupacion", "estado_civil", "email",

                             "tel_principal", "tel_2", "tel_3"] as const) {

          if (persona?.[campo] !== undefined) datosPersona[campo] = persona[campo];

        }
 
        if (Object.keys(datosPersona).length > 0) {

          await tx.personas.update({ where: { id: actual.id_persona }, data: datosPersona });

        }
 
        // --- Domicilio vigente ---

        if (domicilio && Object.keys(domicilio).length > 0) {

          const vinculo = actual.persona.domicilios[0];

          const datosDom: any = {};
 
          if (domicilio.calle) {

            datosDom.calle = domicilio.calle.trim();

            datosDom.calle_busq = normalizarBusqueda(domicilio.calle);

          }

          for (const campo of ["numero_ext", "numero_int", "colonia", "cp",

                               "municipio", "estado", "entre_calles", "tipo_vivienda"] as const) {

            if (domicilio[campo] !== undefined) datosDom[campo] = domicilio[campo];

          }
 
          if (vinculo) {

            await tx.domicilios.update({ where: { id: vinculo.id_domicilio }, data: datosDom });

          } else if (domicilio.calle) {

            // No tenía domicilio vigente: crear uno.

            const nuevo = await tx.domicilios.create({

              data: { ...datosDom, calle: domicilio.calle.trim(),

                      calle_busq: normalizarBusqueda(domicilio.calle) }

            });

            await tx.persona_domicilio.create({

              data: { id_persona: actual.id_persona, id_domicilio: nuevo.id, vigente: true }

            });

          }

        }
 
        // --- Cliente ---

        if (cliente && Object.keys(cliente).length > 0) {

          await tx.clientes.update({

            where: { id },

            data: {

              ...(cliente.zona !== undefined && { zona: cliente.zona }),

              ...(cliente.sector !== undefined && { sector: cliente.sector }),

              ...(cliente.estatus !== undefined && { estatus: cliente.estatus }),

              ...(cliente.observaciones !== undefined && { observaciones: cliente.observaciones })

            }

          });

        }

      });
 
      return res.status(200).json({ message: "Cliente actualizado correctamente" });
 
    } catch (error) {

      console.error(error);

      return res.status(500).json({ message: "Error interno del servidor" });

    }

  }

);
 

export default router;
