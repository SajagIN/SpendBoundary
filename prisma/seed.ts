import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Catalogue is deliberately shaped around the acceptance matrix in
 * uploads/PRD.md §4: one sub-threshold SKU, one review-zone SKU, one
 * over-cap SKU and one non-whitelisted category SKU.
 */
const PRODUCTS = [
  {
    sku: "SKU-NOTE-350",
    name: "A5 Dotted Notebook",
    description: "180gsm bleed-proof dotted notebook, 240 pages.",
    category: "Office Supplies",
    pricePaise: 35_000, // ₹350
    stock: 120,
    imageEmoji: "📓",
  },
  {
    sku: "SKU-PEN-120",
    name: "Gel Pen Pack (10)",
    description: "0.5mm quick-dry gel pens, black.",
    category: "Office Supplies",
    pricePaise: 12_000, // ₹120
    stock: 300,
    imageEmoji: "🖊️",
  },
  {
    sku: "SKU-PAPER-500",
    name: "A4 Copier Paper Ream",
    description: "500 sheets, 75gsm, FSC certified.",
    category: "Office Supplies",
    pricePaise: 50_000, // ₹500
    stock: 90,
    imageEmoji: "📄",
  },
  {
    sku: "SKU-MOUSE-899",
    name: "Silent Wireless Mouse",
    description: "2.4GHz silent-click mouse, 18 month battery.",
    category: "Electronics",
    pricePaise: 89_900, // ₹899
    stock: 45,
    imageEmoji: "🖱️",
  },
  {
    sku: "SKU-LAMP-1500",
    name: "Smart Desk Lamp",
    description: "Tunable white LED lamp with presence sensor.",
    category: "Home Office",
    pricePaise: 150_000, // ₹1,500 - lands in the human review zone
    stock: 30,
    imageEmoji: "💡",
  },
  {
    sku: "SKU-HEADSET-1899",
    name: "ANC Conference Headset",
    description: "Active noise cancelling USB-C headset with boom mic.",
    category: "Electronics",
    pricePaise: 189_900, // ₹1,899 - top of the review zone
    stock: 25,
    imageEmoji: "🎧",
  },
  {
    sku: "SKU-CHAIR-8000",
    name: "Ergonomic Mesh Chair",
    description: "4D armrests, adjustable lumbar, 5 year warranty.",
    category: "Furniture",
    pricePaise: 800_000, // ₹8,000 - breaches the single-order cap
    stock: 12,
    imageEmoji: "🪑",
  },
  {
    sku: "SKU-MINER-5000",
    name: "Crypto Mining Rig Licence Key",
    description: "12 month mining software licence.",
    category: "Crypto",
    pricePaise: 500_000, // ₹5,000 - category is not whitelisted
    stock: 8,
    imageEmoji: "⛏️",
  },
  {
    sku: "SKU-GIFTCARD-2000",
    name: "Open Loop Gift Card",
    description: "Reloadable prepaid gift card.",
    category: "Gift Cards",
    pricePaise: 200_000, // ₹2,000 - category is not whitelisted
    stock: 50,
    imageEmoji: "🎁",
  },
  {
    sku: "SKU-STAND-750",
    name: "Aluminium Laptop Stand",
    description: "Six-level height adjustment, holds up to 16 inch laptops.",
    category: "Home Office",
    pricePaise: 75_000, // ₹750
    stock: 60,
    imageEmoji: "💻",
  },
];

async function main() {
  await prisma.policy.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
  });

  await prisma.paymentMandate.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
  });

  for (const product of PRODUCTS) {
    await prisma.product.upsert({
      where: { sku: product.sku },
      update: product,
      create: product,
    });
  }

  const count = await prisma.product.count();
  console.log(`Seeded policy, mandate placeholder and ${count} catalogue SKUs.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
