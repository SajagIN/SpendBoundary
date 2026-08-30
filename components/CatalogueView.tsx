"use client";

import { useState } from "react";
import { Panel, formatPaise } from "./ui";

export type CatalogueProduct = {
  sku: string;
  name: string;
  description: string;
  category: string;
  pricePaise: number;
  priceFormatted: string;
  stock: number;
  categoryWhitelisted: boolean;
};

export default function CatalogueView({
  products,
  approvalThresholdPaise,
  maxOrderPaise,
}: {
  products: CatalogueProduct[];
  approvalThresholdPaise: number;
  maxOrderPaise: number;
}) {
  const [query, setQuery] = useState("");

  const filtered = products.filter((product) =>
    `${product.name} ${product.category} ${product.sku}`.toLowerCase().includes(query.toLowerCase()),
  );

  function zoneOf(product: CatalogueProduct) {
    if (!product.categoryWhitelisted) {
      return { label: "DENY · category", color: "#EF4444", bg: "rgba(239,68,68,0.10)" };
    }
    if (product.pricePaise > maxOrderPaise) {
      return { label: "DENY · over cap", color: "#EF4444", bg: "rgba(239,68,68,0.10)" };
    }
    if (product.pricePaise >= approvalThresholdPaise) {
      return { label: "REVIEW", color: "#F59E0B", bg: "rgba(245,158,11,0.10)" };
    }
    return { label: "ALLOW", color: "#10B981", bg: "rgba(16,185,129,0.10)" };
  }

  return (
    <Panel
      title="Merchant Catalogue"
      subtitle="Prices are integer paise and are the only prices the gateway will honour."
      right={
        <input
          className="input w-56"
          placeholder="Search SKUs…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((product) => {
          const zone = zoneOf(product);
          return (
            <article key={product.sku} className="glass p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="text-2xl">{"📦"}</div>
                <span
                  className="chip"
                  style={{ color: zone.color, background: zone.bg, borderColor: zone.color + "55" }}
                >
                  {zone.label}
                </span>
              </div>
              <h3 className="mt-2 font-semibold">{product.name}</h3>
              <p className="mt-0.5 text-xs text-slate-400">{product.description}</p>
              <div className="mt-3 flex items-end justify-between">
                <div>
                  <div className="metric">{formatPaise(product.pricePaise)}</div>
                  <div className="font-mono text-[11px] text-slate-500">{product.pricePaise} paise</div>
                </div>
                <div className="text-right text-xs text-slate-400">
                  <div>{product.category}</div>
                  <div>{product.stock} in stock</div>
                </div>
              </div>
              <div className="hash mt-2">{product.sku}</div>
            </article>
          );
        })}
      </div>
      {filtered.length === 0 && <p className="text-sm text-slate-400">No SKUs match that search.</p>}
    </Panel>
  );
}
