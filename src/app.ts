import express from "express";
import authRoutes from "./routes/auth.routes.js";
import "dotenv/config";
import usuariosRoutes from "./routes/usuarios.routes.js";
import clientesRoutes from "./routes/clientes.routes.js"
import helmet from "helmet";
import cors from "cors";



const app = express();

app.use (helmet());
app.use(cors({origin:"http://localhost:5173"}));
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api",usuariosRoutes);
app.use("/api", clientesRoutes);
const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});