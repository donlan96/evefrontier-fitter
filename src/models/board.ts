export type BoardCell = 0 | 1;

export interface GridPoint {
  x: number;
  y: number;
}

export interface BoardDefinition {
  id: string;
  name: string;
  width: number;
  height: number;
  mask: BoardCell[][];
}
