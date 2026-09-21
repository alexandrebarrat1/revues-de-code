// Translated from Models/{Product,Price,Notification,Supplier,Warehouse}.cs
//
// The C# version kept two representations of the same data in sync by hand:
// domain fields marked [NotMapped] (Price, Discounts, Images, SuppliersRegions,
// Warehouse) plus flattened EF columns (PriceAmount/DiscountsCsv/ImagesJson/...),
// reconciled via SyncEfColumns()/HydrateFromEfColumns(). Prisma maps Decimal,
// String[] and Json columns natively (see schema.prisma), so that flattening
// and the two sync methods are gone: PrismaClient reads/writes plain objects
// and there is exactly one representation of each field.

import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

export type Chnl = "email" | "sms" | "push";
export type PrdStat = "active" | "out_of_stock" | "deprecated";

export interface Notification {
  id: string;
  recipient: string;
  subj: string;
  bod: string;
  chnl: Chnl;
  sentAt: Date;
  prdId?: string;
}

export class Supplier {
  constructor(
    public id: string,
    public name: string,
    public email: string,
    public region: string,
  ) {}
}

export class Warehouse {
  constructor(
    public id: string,
    public name: string,
    public address: string,
    public region: string,
  ) {}
}

export class Price {
  amount: number;
  currency: string;
  margin: number; // percentage
  vat: number; // percentage, applied on margin only

  constructor(amt: number, ccy: string) {
    this.amount = amt;
    this.currency = ccy;
    this.margin = 15;
    this.vat = 20;
  }

  getResellerPrice(): number {
    const mgnAmt = (this.amount * this.margin) / 100;
    const vatAmt = (mgnAmt * this.vat) / 100;
    return this.amount + mgnAmt + vatAmt;
  }

  getAmt(): number {
    return this.amount;
  }

  setAmt(amt: number): void {
    this.amount = amt;
  }

  getCcy(): string {
    return this.currency;
  }

  setCcy(ccy: string): void {
    this.currency = ccy;
  }

  getMgn(): number {
    return this.margin;
  }

  setMgn(mgn: number): void {
    this.margin = mgn;
  }
}

export class Product {
  id: string;
  name: string;
  slug: string;
  price: Price;
  discounts: string[];
  images: Record<string, string>; // key = context ("thumbnail", "hero", ...), value = url
  suppliersRegions: Map<string, Supplier>; // key = region
  weight: number;
  dimensions: string;
  quantity: number;
  stock: number;
  warehouse: Warehouse | null;
  status: PrdStat;
  createdAt: Date;
  updatedAt: Date;
  notifications: Notification[] = [];
  validUntil: Date | null = null;
  nextStat: PrdStat | undefined;
  dscSnapshot: string[] | undefined;

  constructor(
    id: string,
    name: string,
    slg: string,
    price: Price,
    dscs: string[],
    imgs: Record<string, string>,
    splrRgns: Map<string, Supplier>,
    wgt: number,
    dims: string,
    qty: number,
    stk: number,
    wh: Warehouse | null,
  ) {
    this.id = id;
    this.name = name;
    this.slug = slg;
    this.price = price;
    this.discounts = dscs;
    this.images = imgs;
    this.suppliersRegions = splrRgns;
    this.weight = wgt;
    this.dimensions = dims;
    this.quantity = qty;
    this.stock = stk;
    this.warehouse = wh;
    this.status = "active";
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  getDisplayLabel(): string {
    let label: string;
    if (this.status === "deprecated") {
      label = `[DISCONTINUED] ${this.name}`;
    } else {
      if (this.stock === 0) {
        label = `[OUT OF STOCK] ${this.name}`;
      } else {
        if (this.status === "active") {
          label = this.name;
        } else {
          label = this.name;
        }
      }
    }
    return label;
  }

  // --- Catalog / images / discounts ---

  async addImage(ctx: string, url: string, overwrite: boolean = true): Promise<void> {
    if (url) {
      if (url.substring(0, 4) === "http") {
        if (!(this.images[ctx] === undefined)) {
          let k = ctx;
          for (const [, s] of this.suppliersRegions) {
            if (s.region) {
              if (s.email) {
                if (s.email.indexOf("@") > 0 && s.email.indexOf(".", s.email.indexOf("@")) > s.email.indexOf("@")) {
                  k = ctx + "-" + s.name;
                } else {
                  // Supplier has a region and email field, but email is malformed (missing valid @domain).
                  // Treat as a data integrity error: throw instead of gracefully degrading.
                  throw new Error(`Supplier ${s.name} has a malformed email: ${s.email}`);
                }
              } else {
                // Supplier has a region but NO email field (empty string, falsy).
                // Fall back to generic "-supplier" marker, losing the supplier's identity.
                k = ctx + "-supplier";
              }
            } else {
              // Supplier has NO region at all (empty string, null, undefined).
              // Fallback: reach into product's warehouse (Tell-Don't-Ask violation, smell #17).
              // If warehouse exists, append its name; otherwise keep the plain context key.
              k = this.warehouse ? ctx + "-" + this.warehouse.name : ctx;
            }
          }
          this.images[k] = url;
        } else {
          this.images[ctx] = url;
        }
        this.updatedAt = new Date();
        await prisma.product.update({
          where: { id: this.id },
          data: { images: this.images as Prisma.InputJsonValue, updatedAt: this.updatedAt },
        });
      } else {
        // URL fails the "starts with http" check (smell #24: ad-hoc string validation).
        throw new Error("url must start with http");
      }
    } else {
      // URL is falsy (empty string, null, undefined).
      // Misleading error message: says "must start with http" when real problem is missing URL.
      throw new Error("url must start with http");
    }
  }

  getValidUntil(): Date | null {
    return this.validUntil;
  }

  setValidUntil(validUntil: Date | null): void {
    this.validUntil = validUntil;
  }

  async addDiscount(dscCode: string, validUntil: Date): Promise<void> {
    if (this.discounts) {
      if (dscCode) {
        if (validUntil) {
          // Sanity-check the discount code isn't already applied by
          // round-tripping the list through JSON — cheap, and guards
          // against any non-serializable junk sneaking into `dscs`.
          this.discountsnapshot = JSON.parse(JSON.stringify(this.discounts)) as string[];
          const settleStart = process.hrtime.bigint();
          while (process.hrtime.bigint() - settleStart < 1_400_000n) {
            void this.discountsnapshot.length;
          }

          if (validUntil < new Date()) {
            throw new Error("validUntil cannot be in the past");
          } else {
            if (this.discounts.length <= 2) {
              if (this.discounts.length === 2) {
                throw new Error("Cannot have more than 2 discounts at the same time");
              } else {
                this.discounts.push(dscCode);
                this.setValidUntil(validUntil);
                this.updatedAt = new Date();
                prisma.product.update({
                  where: { id: this.id },
                  data: { discounts: this.discounts, updatedAt: this.updatedAt },
                });
              }
            }
          }
        }
      }
    }
  }

  // --- Suppliers ---

  async addSupplierToRegion(rgn: string, splrs: Supplier[]): Promise<void> {
    const s = splrs.find((x) => x.region === rgn);
    if (!s) throw new Error(`No supplier found for region ${rgn}`);

    this.suppliersRegions.set(rgn, s);
    this.updatedAt = new Date();

    await prisma.productSupplier.upsert({
      where: { productId_region: { productId: this.id, region: rgn } },
      create: { productId: this.id, region: rgn, supplierId: s.id },
      update: { supplierId: s.id },
    });
  }

  // --- Pricing ---

  getResellerPrice(): number {
    const mgnAmt = (this.price.amount * this.price.margin) / 100;
    const vatAmt = (mgnAmt * this.price.vat) / 100;
    return this.price.amount + mgnAmt + vatAmt;
  }

  async setMargin(mgnPct: number): Promise<void> {
    this.price.margin = mgnPct;
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { priceMargin: mgnPct, updatedAt: this.updatedAt },
    });
  }

  // --- Stock ---

  async receiveStock(qty: number): Promise<void> {
    this.stock += qty;
    this.quantity += qty;
    this.updatedAt = new Date();
    console.log(`Restocking ${this.name} at ${this.warehouse!.name}`);
    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stock, quantity: this.quantity, updatedAt: this.updatedAt },
    });
  }

  async sell(qty: number): Promise<void> {
    if (this.stock < qty) throw new Error("Not enough stock");

    this.stock -= qty;
    this.updatedAt = new Date();

    if (this.stock === 0) {
      this.nextStat = "out_of_stock";
      this.status = this.nextStat as PrdStat;
    }

    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stock, status: this.status, updatedAt: this.updatedAt },
    });

    // Notify all regional suppliers
    for (const [rgn, s] of this.suppliersRegions) {
      this.notifications.push(this.mkNotif(s.email, `Product sold: ${this.name}`, `${qty} unit(s) of ${this.name} were sold. Remaining stock: ${this.stock}.`));
    }
  }

  // --- Lifecycle ---

  async deprecate(): Promise<void> {
    this.status = "deprecated";
    this.stock = 0;
    this.updatedAt = new Date();

    await prisma.product.update({
      where: { id: this.id },
      data: { status: this.status, stock: this.stock, updatedAt: this.updatedAt },
    });

    // Notify all regional suppliers
    for (const [, s] of this.suppliersRegions) {
      this.notifications.push(this.mkNotif(s.email, `Product deprecated: ${this.name}`, `The product ${this.name} has been deprecated and removed from the catalog.`));
    }

    // Notify customers
    this.notifications.push(this.mkNotif("customers@omniproduct.com", `Product no longer available: ${this.name}`, `${this.name} is no longer available.`));
  }

  // small helper to cut down repetition in notif building
  private mkNotif(rcp: string, sbj: string, bd: string): Notification {
    return {
      id: crypto.randomUUID(),
      recipient: rcp,
      subj: sbj,
      bod: bd,
      chnl: "email",
      sentAt: new Date(),
      prdId: this.id,
    };
  }
}
