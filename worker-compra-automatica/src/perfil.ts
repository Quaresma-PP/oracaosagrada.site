import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Perfil do Chrome usado pela fila assistida, com o login da loja salvo.
// Fica só no computador do usuário (fora do git e do Docker).
export const PERFIL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".perfil-navegador");
