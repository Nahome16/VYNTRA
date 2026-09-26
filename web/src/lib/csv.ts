import { saveBlob } from "@/lib/download-file";

const NUMERIC_TEXT = /^-?\d+(?:[.,]\d+)?$/;
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Celda CSV entre comillas y protegida contra inyeccion de formulas: si el texto
 * empieza con = + - @ tabulador o retorno de carro, se antepone una comilla
 * simple para que Excel/Sheets lo traten como texto. Los numeros (incluidos los
 * negativos) se dejan tal cual.
 */
export function csvCell(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (typeof value !== "number" && FORMULA_PREFIX.test(text) && !NUMERIC_TEXT.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvDocument(header: Array<string | number>, rows: Array<Array<string | number | null | undefined>>) {
  return [header.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\n");
}

export function downloadCsv(filename: string, header: Array<string | number>, rows: Array<Array<string | number | null | undefined>>) {
  saveBlob(new Blob([csvDocument(header, rows)], { type: "text/csv;charset=utf-8" }), filename);
}
