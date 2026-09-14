/**
 * TD1 — Code à revoir : la caisse du magasin.
 *
 * Ce fichier contient volontairement plusieurs problèmes (logique, typage,
 * lisibilité, conception). À vous de les identifier en commentaires de
 * revue, puis d'en corriger au moins trois.
 */

// Nom pas  clair, item peut être toute chose
interface Produit {
  name: string;
  price: number;
  qantiterSelectionne: number;
}

// TAX_RATE == TVA
const TVA = 0.2;

// Calcule le total TTC du panier
// double responsabiliter appliquer le total du panier et la TVA 
// Deux fonction
export function totalPricePanierHT(listeProduits: Produit[]): number {
  let total = 0;
  for (const produit of listeProduits) {
    if (produit.price <= 0 || produit.qantiterSelectionne <= 0):
      throw Error("Price or produit negatif")
    total += produit.price * produit.qantiterSelectionne;
  }
  return total;
}

export function priceTTC(price: number): number{
  return price + price * TVA
}

// Formate un prix en euros
export function formatPrice(price: number): string {
  return price.toFixed(2) + " €";
}

// Encaisse le panier : affiche le total et prépare le paiement

// Double responsabilité, deux fonctions
export function checkout(listeProduits: Produit[]) {
  let price = calculPricePanierTTC(listeProduits);
  if (price === 0) {
    console.log("Panier vide");
    return;
  }
  console.log("Total à payer : " + formatPrice(price));
  // TODO: intégrer le paiement
}

export function calculPricePanierTTC(listeProduits: Produit[]) : number{
    if (listeProduits.length === 0) {
    return 0;
  }
  const totalHT = totalPricePanierHT(listeProduits);
  return priceTTC(totalHT);
}
