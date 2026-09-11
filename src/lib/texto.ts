/*  Normaliza texto para búsqueda: mayúsculas, sin acentos, sin

    espacios repetidos. Se guarda en las columnas *_busq para que

    MySQL pueda usar índice en búsquedas por prefijo (LIKE 'JUAN%').

*/

export function normalizarBusqueda(texto: string | null | undefined): string {

  if (!texto) return "";

  return texto

    .normalize("NFD")

    .replace(/[\u0300-\u036f]/g, "")   // quita acentos

    .toUpperCase()

    .replace(/\s+/g, " ")

    .trim();

}
 
/*  Valida la estructura de una CURP mexicana.

    NO valida el dígito verificador ni que exista en RENAPO: solo

    que tenga la forma correcta. Suficiente para atajar capturas

    obviamente erróneas sin rechazar CURPs legítimas raras.

*/

const CURP_REGEX = /^[A-Z][AEIOUX][A-Z]{2}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/;
 
export function esCurpValida(curp: string): boolean {

  return CURP_REGEX.test(curp.toUpperCase().trim());

}
 
export function normalizarCurp(curp: string): string {

  return curp.toUpperCase().trim();

}
 