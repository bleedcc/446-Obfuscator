import { createFileRoute } from "@tanstack/react-router";
import { ObfuscatorApp } from "@/components/obfuscator-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <ObfuscatorApp />;
}
