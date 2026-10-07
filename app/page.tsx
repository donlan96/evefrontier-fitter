import { ShipFitterApp } from "@/src";
import { exampleBoard } from "@/src/data/exampleBoard";
import { exampleModules } from "@/src/data/exampleModules";

export default function Home() {
  return <ShipFitterApp initialBoard={exampleBoard} initialModules={exampleModules} />;
}
