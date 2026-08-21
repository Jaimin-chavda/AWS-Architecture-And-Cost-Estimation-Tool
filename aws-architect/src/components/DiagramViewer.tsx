"use client";

import React, { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, RefreshCw, ZoomIn } from "lucide-react";

export interface DiagramViewerProps {
  diagramXml: string;
  filename: string;
  patternTitle?: string;
}

const DRAWIO_EMBED_URL =
  "https://embed.diagrams.net/?embed=1&ui=atlas&spin=1&modified=unsavedChanges&proto=json";

export function DiagramViewer({
  diagramXml,
  filename,
  patternTitle,
}: DiagramViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    const handler = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      try {
        const msg = JSON.parse(ev.data as string) as { event: string };
        if (msg.event === "init") {
          // draw.io iframe is ready — send the XML
          iframeRef.current?.contentWindow?.postMessage(
            JSON.stringify({ action: "load", xml: diagramXml }),
            "*"
          );
          setReady(true);
        }
      } catch {
        // non-JSON messages from draw.io are expected
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [diagramXml]);

  function handleDownload() {
    const blob = new Blob([diagramXml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleOpenDrawio() {
    // Open diagrams.net web editor
    window.open("https://app.diagrams.net", "_blank");
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
          <p className="text-xs text-muted">
            Interactive AWS architecture canvas. You can drag and rearrange nodes directly in the diagram.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-4 py-1.5 text-xs font-medium text-accent-light shadow-sm transition-all hover:border-accent/60 hover:bg-accent/20 active:scale-95"
            title="Download .drawio XML file to edit locally or import to Diagrams.net"
          >
            <Download className="h-3.5 w-3.5 text-accent" />
            <span>Download .drawio</span>
          </button>

          <button
            onClick={handleOpenDrawio}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2/60 px-3.5 py-1.5 text-xs font-medium text-muted transition-all hover:border-accent/40 hover:text-foreground active:scale-95"
            title="Open in draw.io web editor"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">draw.io</span>
          </button>
        </div>
      </div>

      {/* Frame Container */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-surface-2/70 shadow-xl backdrop-blur-md">
        {!ready && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface/90 backdrop-blur-sm">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 border border-accent/20">
              <RefreshCw className="h-5 w-5 animate-spin text-accent" />
            </div>
            <span className="font-mono text-xs text-muted">
              Rendering cloud topology canvas…
            </span>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={DRAWIO_EMBED_URL}
          className="h-[540px] w-full sm:h-[600px]"
          title="AWS Architecture Blueprint"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </div>
    </div>
  );
}
