// Translated from Models/{Product,Price,Notification,Supplier,Warehouse}.cs
//
// The C# version kept two representations of the same data in sync by hand:
// domain fields marked [NotMapped] (Price, Discounts, Images, SuppliersRegions,
// Warehouse) plus flattened EF columns (PriceAmount/DiscountsCsv/ImagesJson/...),
// reconciled via SyncEfColumns()/HydrateFromEfColumns(). Prisma maps Decimal,
// String[] and Json columns natively (see schema.prisma), so that flattening
// and the two sync methods are gone: PrismaClient reads/writes plain objects
// and there is exactly one representation of each field.

/**
 * Modèle de domaine Product — Gestion des produits, stocks, prix et remises.
 */
import { PrismaClient, Prisma } from "@prisma/client";

export const prisma = new PrismaClient();

export class InsufficientStockError extends Error {
  constructor(message = "Not enough stock") {
    super(message);
    this.name = "InsufficientStockError";
  }
}

export class MaxDiscountsExceededError extends Error {
  constructor(message = "Cannot have more than 2 discounts at the same time") {
    super(message);
    this.name = "MaxDiscountsExceededError";
  }
}

export class InvalidDiscountDateError extends Error {
  constructor(message = "validUntil cannot be in the past") {
    super(message);
    this.name = "InvalidDiscountDateError";
  }
}

export class SupplierNotFoundError extends Error {
  constructor(region: string) {
    super("No supplier found for region " + region);
    this.name = "SupplierNotFoundError";
  }
}

export class MalformedSupplierEmailError extends Error {
  constructor(supplierName: string, email: string) {
    super("Supplier " + supplierName + " has a malformed email: " + email);
    this.name = "MalformedSupplierEmailError";
  }
}

export class InvalidImageUrlError extends Error {
  constructor(message = "url must start with http") {
    super(message);
    this.name = "InvalidImageUrlError";
  }
}

export type Channel = "email" | "sms" | "push";
export type ProductStatus = "active" | "out_of_stock" | "deprecated";

export class InvalidStatusTransitionError extends Error {
  constructor(from: ProductStatus, to: ProductStatus) {
    super(`Cannot transition product status from ${from} to ${to}`);
    this.name = "InvalidStatusTransitionError";
  }
}

export class ProductDeprecatedError extends Error {
  constructor(productName: string) {
    super(`Cannot operate on deprecated product: ${productName}`);
    this.name = "ProductDeprecatedError";
  }
}

export const ALLOWED_STATUS_TRANSITIONS: Record<ProductStatus, readonly ProductStatus[]> = {
  active: ["out_of_stock", "deprecated"],
  out_of_stock: ["active", "deprecated"],
  deprecated: [],
};

export const DEFAULT_MARGIN_PERCENT = 15;
export const DEFAULT_VAT_PERCENT = 20;
export const MAX_DISCOUNTS_COUNT = 2;

export interface Notification {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  channel: Channel;
  sentAt: Date;
  productId?: string;
}

function createNotification(
  recipient: string,
  subject: string,
  body: string,
  channel: Channel,
  productId?: string,
): Notification {
  return {
    id: crypto.randomUUID(),
    recipient,
    subject,
    body,
    channel,
    sentAt: new Date(),
    productId,
  };
}

export class Supplier {
  static readonly EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  constructor(
    public id: string,
    public name: string,
    public email: string,
    public region: string,
  ) {}

  hasRegion(): boolean {
    return Boolean(this.region);
  }

  getDisambiguationKey(context: string): string {
    if (!this.hasRegion()) return context;
    if (!this.email) return `${context}-supplier`;
    if (!Supplier.EMAIL_REGEX.test(this.email)) {
      throw new MalformedSupplierEmailError(this.name, this.email);
    }
    return `${context}-${this.name}`;
  }

  createNotification(subject: string, body: string, productId: string): Notification {
    return createNotification(this.email, subject, body, "email", productId);
  }
}

export class Warehouse {
  constructor(
    public id: string,
    public name: string,
    public address: string,
    public region: string,
  ) {}

  getLocationSuffix(): string {
    return ` at ${this.name}`;
  }

  getDisambiguationKey(context: string): string {
    return `${context}-${this.name}`;
  }
}

export class Price {
  amount: number;
  currency: string;
  margin: number; // percentage
  vat: number; // percentage, applied on margin only

  constructor(amount: number, currency: string) {
    this.amount = amount;
    this.currency = currency;
    this.margin = DEFAULT_MARGIN_PERCENT;
    this.vat = DEFAULT_VAT_PERCENT;
  }

  getResellerPrice(): number {
    const marginAmount = (this.amount * this.margin) / 100;
    const vatAmount = (marginAmount * this.vat) / 100;
    return this.amount + marginAmount + vatAmount;
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
  private currentStatus: ProductStatus;
  createdAt: Date;
  updatedAt: Date;
  notifications: Notification[] = [];
  validUntil: Date | null = null;

  constructor(
    id: string,
    name: string,
    slug: string,
    price: Price,
    discounts: string[],
    images: Record<string, string>,
    suppliersRegions: Map<string, Supplier>,
    weight: number,
    dimensions: string,
    quantity: number,
    stock: number,
    warehouse: Warehouse | null,
  ) {
    this.id = id;
    this.name = name;
    this.slug = slug;
    this.price = price;
    this.discounts = discounts;
    this.images = images;
    this.suppliersRegions = suppliersRegions;
    this.weight = weight;
    this.dimensions = dimensions;
    this.quantity = quantity;
    this.stock = stock;
    this.warehouse = warehouse;
    this.currentStatus = "active";
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  flushNotifications(): Notification[] {
    const pendingNotifications = [...this.notifications];
    this.notifications = [];
    return pendingNotifications;
  }

  get status(): ProductStatus {
    return this.currentStatus;
  }

  transitionTo(newStatus: ProductStatus): void {
    if (this.currentStatus === newStatus) return;

    if (!ALLOWED_STATUS_TRANSITIONS[this.currentStatus].includes(newStatus)) {
      throw new InvalidStatusTransitionError(this.currentStatus, newStatus);
    }

    this.currentStatus = newStatus;
  }

  getDisplayLabel(): string {
    if (this.status === "deprecated") {
      return `[DISCONTINUED] ${this.name}`;
    }
    if (this.stock === 0) {
      return `[OUT OF STOCK] ${this.name}`;
    }
    return this.name;
  }

  // --- Catalog / images / discounts ---

  async addImage(context: string, url: string): Promise<void> {
    if (!url) {
      throw new InvalidImageUrlError("url is required");
    }
    if (!this.isValidHttpUrl(url)) {
      throw new InvalidImageUrlError("url must be a valid HTTP or HTTPS URL");
    }

    if (this.images[context] === undefined) {
      this.images[context] = url;
      this.updatedAt = new Date();
      await prisma.product.update({
        where: { id: this.id },
        data: { images: this.images as Prisma.InputJsonValue, updatedAt: this.updatedAt },
      });
      return;
    }

    const imageKey = this.resolveImageKey(context);
    this.images[imageKey] = url;
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { images: this.images as Prisma.InputJsonValue, updatedAt: this.updatedAt },
    });
  }

  /**
   * Image-key fallback policy: use the first registered supplier; add its name
   * when it has a valid email, use a generic suffix when it has no email, and
   * use the warehouse name (or the unchanged context) when it has no region.
   */
  private resolveImageKey(context: string): string {
    for (const supplier of this.suppliersRegions.values()) {
      if (supplier.hasRegion()) {
        return supplier.getDisambiguationKey(context);
      }
      return this.warehouse
        ? this.warehouse.getDisambiguationKey(context)
        : context;
    }
    return context;
  }

  private isValidHttpUrl(urlString: string): boolean {
    try {
      const parsedUrl = new URL(urlString);
      return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
    } catch {
      return false;
  }
  }

  getValidUntil(): Date | null {
    return this.validUntil;
  }

  setValidUntil(validUntil: Date | null): void {
    this.validUntil = validUntil;
  }

  async addDiscount(discountCode: string, validUntil: Date): Promise<void> {
    if (validUntil < new Date()) {
      throw new InvalidDiscountDateError();
    }
    if (this.discounts.length >= MAX_DISCOUNTS_COUNT) {
      throw new MaxDiscountsExceededError();
    }

    this.discounts.push(discountCode);
    this.setValidUntil(validUntil);
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { discounts: this.discounts, updatedAt: this.updatedAt },
    });
  }

  // --- Suppliers ---

  /**
   * Hydrates the in-memory region map from the product-supplier join table.
   * After a successful load, the map contains exactly the suppliers linked
   * to this product in persistence.
   */
  async loadSuppliersFromDb(): Promise<void> {
    const supplierLinks = await prisma.productSupplier.findMany({
      where: { productId: this.id },
      include: {
        supplier: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    this.suppliersRegions.clear();
    for (const link of supplierLinks) {
      const { id, name, email } = link.supplier;
      this.suppliersRegions.set(link.region, new Supplier(id, name, email, link.region));
    }
  }

  async addSupplierToRegion(region: string, suppliers: Supplier[]): Promise<void> {
    const supplier = suppliers.find((candidate) => candidate.region === region);
    if (!supplier) throw new SupplierNotFoundError(region);

    this.suppliersRegions.set(region, supplier);
    this.updatedAt = new Date();

    await prisma.productSupplier.upsert({
      where: { productId_region: { productId: this.id, region } },
      create: { productId: this.id, region, supplierId: supplier.id },
      update: { supplierId: supplier.id },
    });
  }

  // --- Pricing ---

  getResellerPrice(): number {
    return this.price.getResellerPrice();
  }

  async setMargin(marginPercentage: number): Promise<void> {
    this.price.margin = marginPercentage;
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { priceMargin: marginPercentage, updatedAt: this.updatedAt },
    });
  }

  // --- Stock ---

  async receiveStock(quantity: number): Promise<void> {
    if (this.status === "deprecated") throw new ProductDeprecatedError(this.name);

    this.stock += quantity;
    this.quantity += quantity;
    if (this.status === "out_of_stock" && this.stock > 0) {
      this.transitionTo("active");
    }
    this.updatedAt = new Date();
    const warehouseLocation = this.warehouse?.getLocationSuffix() ?? "";
    console.log(`Restocking ${this.name}${warehouseLocation}`);
    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stock, quantity: this.quantity, updatedAt: this.updatedAt },
    });
  }

  async sell(quantity: number): Promise<void> {
    if (this.status === "deprecated") throw new ProductDeprecatedError(this.name);
    if (this.stock < quantity) throw new InsufficientStockError();

    const previousStock = this.stock;
    const previousStatus = this.status;
    const previousUpdatedAt = this.updatedAt;
    const nextStock = this.stock - quantity;
    const nextStatus = nextStock === 0 ? "out_of_stock" : this.status;
    const nextUpdatedAt = new Date();

    try {
      await prisma.product.update({
        where: { id: this.id },
        data: { stock: nextStock, status: nextStatus, updatedAt: nextUpdatedAt },
      });
    } catch (error) {
      this.stock = previousStock;
      this.currentStatus = previousStatus;
      this.updatedAt = previousUpdatedAt;
      throw error;
    }

    this.stock = nextStock;
    this.transitionTo(nextStatus);
    this.updatedAt = nextUpdatedAt;

    // Notify all regional suppliers
    this.notifyRegionalSuppliers(
      `Product sold: ${this.name}`,
      `${quantity} unit(s) of ${this.name} were sold. Remaining stock: ${this.stock}.`
    );
  }

  // --- Lifecycle ---

  async deprecate(): Promise<void> {
    this.transitionTo("deprecated");
    this.stock = 0;
    this.updatedAt = new Date();

    await prisma.product.update({
      where: { id: this.id },
      data: { status: this.status, stock: this.stock, updatedAt: this.updatedAt },
    });

    // Notify all regional suppliers
    this.notifyRegionalSuppliers(
      `Product deprecated: ${this.name}`,
      `The product ${this.name} has been deprecated and removed from the catalog.`
    );

    // Notify customers
    this.notifications.push(this.createNotification("customers@omniproduct.com", `Product no longer available: ${this.name}`, `${this.name} is no longer available.`));
  }

  private notifyRegionalSuppliers(subject: string, body: string): void {
    for (const supplier of this.suppliersRegions.values()) {
      this.notifications.push(supplier.createNotification(subject, body, this.id));
    }
  }

  // small helper to cut down repetition in notif building
  private createNotification(recipient: string, subject: string, body: string): Notification {
    return createNotification(recipient, subject, body, "email", this.id);
  }
}
