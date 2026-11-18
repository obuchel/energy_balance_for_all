/**
 * Health Data Adapter (formerly longCovidDataAdapter)
 *
 * Supports all users — general, Long COVID, ME/CFS, fibromyalgia, histamine intolerance, etc.
 * Reads both the new generic field names AND the legacy longCovid* field names from Firebase,
 * so existing meal documents don't need migration.
 *
 * Field name map (old → new):
 *   longCovidBenefits   → healthBenefits
 *   longCovidCautions   → healthCautions
 *   longCovidServings   → recommendedServings
 *   longCovidRelevance  → healthRelevance
 *   hasLongCovid        → hasCondition  (on user profile)
 *   covid_severity /
 *   longCovidSeverity   → conditionSeverity (on user profile)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compatible field accessors for meal documents
// ─────────────────────────────────────────────────────────────────────────────

/** Returns health benefits array, reading new field first then legacy. */
export const getHealthBenefits = (food) =>
  food?.healthBenefits || food?.longCovidBenefits || [];

/** Returns health cautions array, reading new field first then legacy. */
export const getHealthCautions = (food) =>
  food?.healthCautions || food?.longCovidCautions || [];

/** Returns recommended servings array, reading new field first then legacy. */
export const getRecommendedServings = (food) =>
  food?.recommendedServings || food?.longCovidServings || [];

/** Returns health relevance object, reading new field first then legacy. */
export const getHealthRelevance = (food) =>
  food?.healthRelevance || food?.longCovidRelevance || {};

// ─────────────────────────────────────────────────────────────────────────────
// User profile condition detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects whether a user has a tracked condition and returns normalized status.
 * Reads both new generic fields and legacy Long COVID fields.
 *
 * @param {object} userData - Firestore user document data
 * @returns {{ hasCondition: boolean, conditionType: string|null, severity: string|null, isLongCovid: boolean }}
 */
export const detectConditionStatus = (userData) => {
  if (!userData) return { hasCondition: false, conditionType: null, severity: null, isLongCovid: false };

  // New format
  if (userData.hasCondition !== undefined) {
    const conditionType = userData.conditionType || null;
    const severity = userData.conditionSeverity || null;
    return {
      hasCondition: !!userData.hasCondition,
      conditionType,
      severity,
      isLongCovid: conditionType === 'long_covid',
    };
  }

  // Legacy Long COVID format
  const severity = userData.covid_severity || userData.longCovidSeverity || userData.severity || null;
  const hasCondition = userData.hasLongCovid === true || (severity && severity !== 'None');
  return {
    hasCondition: !!hasCondition,
    conditionType: hasCondition ? 'long_covid' : null,
    severity,
    isLongCovid: !!hasCondition,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Existing utility functions (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse serving amount string (e.g., "240ml (8 oz)" or "120g")
 */
export const parseServingAmount = (amountString) => {
  if (!amountString) return { weight: 100, unit: 'g' };
  const match = amountString.match(/(\d+)(ml|g|oz)/i);
  if (match) return { weight: parseFloat(match[1]), unit: match[2].toLowerCase() };
  return { weight: 100, unit: 'g' };
};

export const scaleNutrient = (nutrient, servingWeight) => {
  if (!nutrient || typeof nutrient.value !== 'number') return null;
  return { ...nutrient, value: nutrient.value * (servingWeight / 100) };
};

export const scaleAllNutrients = (nutrientsPer100g, servingWeight) => {
  if (!nutrientsPer100g || typeof servingWeight !== 'number') return {};
  const scaleFactor = servingWeight / 100;
  const scaled = {};
  Object.entries(nutrientsPer100g).forEach(([key, nutrient]) => {
    if (nutrient && typeof nutrient.value === 'number') {
      scaled[key] = { ...nutrient, value: nutrient.value * scaleFactor };
    }
  });
  return scaled;
};

export const convertToLegacyFormat = (newFormatFood) => {
  if (!newFormatFood) return null;
  const nutrients = newFormatFood.nutrients?.per100g || {};
  const nutritional_metrics = { nutrients_per_100g: nutrients, serving_options: {} };

  const servings = getRecommendedServings(newFormatFood);
  servings.forEach((serving, index) => {
    const { weight, unit } = parseServingAmount(serving.amount);
    nutritional_metrics.serving_options[`option_${index + 1}`] = {
      weight, unit, description: serving.name,
    };
  });

  return {
    ...newFormatFood,
    nutritional_metrics,
    // Normalize field names for downstream consumers
    healthBenefits: getHealthBenefits(newFormatFood),
    healthCautions: getHealthCautions(newFormatFood),
    recommendedServings: getRecommendedServings(newFormatFood),
    healthRelevance: getHealthRelevance(newFormatFood),
    functionalCompounds: newFormatFood.functionalCompounds,
    properties: newFormatFood.properties,
  };
};

export const getMacrosForServing = (foodData, servingWeight) => {
  const nutrients = foodData.nutrients?.per100g || {};
  const scaleFactor = servingWeight / 100;
  return {
    calories: (nutrients.calories?.value || 0) * scaleFactor,
    protein: (nutrients.protein?.value || 0) * scaleFactor,
    carbs: (nutrients.carbs?.value || 0) * scaleFactor,
    fat: (nutrients.fat?.value || 0) * scaleFactor,
    fiber: (nutrients.fiber?.value || 0) * scaleFactor,
    sugars: (nutrients.sugars?.value || 0) * scaleFactor,
  };
};

export const getMicronutrientsForServing = (foodData, servingWeight) => {
  const nutrients = foodData.nutrients?.per100g || {};
  const scaledNutrients = scaleAllNutrients(nutrients, servingWeight);
  const micronutrients = {};
  const keys = [
    'calcium', 'iron', 'magnesium', 'phosphorus', 'potassium', 'sodium', 'zinc',
    'copper', 'selenium', 'vitamin_a', 'vitamin_c', 'vitamin_d', 'vitamin_e',
    'vitamin_k', 'thiamin', 'riboflavin', 'niacin', 'vitamin_b6', 'folate',
    'vitamin_b12', 'choline',
  ];
  keys.forEach(key => { if (scaledNutrients[key]) micronutrients[key] = scaledNutrients[key]; });
  return micronutrients;
};

export const formatNutrientValue = (value, unit, decimals = 1) => {
  if (typeof value !== 'number' || isNaN(value)) return 'N/A';
  const formatted = value < 1 && value > 0 ? value.toFixed(decimals + 1) : value.toFixed(decimals);
  return `${formatted} ${unit}`;
};

export const getParsedRecommendedServings = (foodData) => {
  const servings = getRecommendedServings(foodData);
  return servings.map((serving, index) => {
    const { weight, unit } = parseServingAmount(serving.amount);
    return { ...serving, parsedWeight: weight, parsedUnit: unit, index };
  });
};

/** @deprecated Use getParsedRecommendedServings */
export const getParsedLongCovidServings = getParsedRecommendedServings;

export const calculateDailyValuePercentage = (nutrientKey, value, unit) => {
  const dailyValues = {
    vitamin_a: { value: 900, unit: 'mcg_RAE' },
    vitamin_c: { value: 90, unit: 'mg' },
    vitamin_d: { value: 20, unit: 'mcg' },
    vitamin_e: { value: 15, unit: 'mg' },
    vitamin_k: { value: 120, unit: 'mcg' },
    thiamin: { value: 1.2, unit: 'mg' },
    riboflavin: { value: 1.3, unit: 'mg' },
    niacin: { value: 16, unit: 'mg' },
    vitamin_b6: { value: 1.7, unit: 'mg' },
    folate: { value: 400, unit: 'mcg' },
    vitamin_b12: { value: 2.4, unit: 'mcg' },
    choline: { value: 550, unit: 'mg' },
    calcium: { value: 1300, unit: 'mg' },
    iron: { value: 18, unit: 'mg' },
    magnesium: { value: 420, unit: 'mg' },
    phosphorus: { value: 1250, unit: 'mg' },
    potassium: { value: 4700, unit: 'mg' },
    sodium: { value: 2300, unit: 'mg' },
    zinc: { value: 11, unit: 'mg' },
    copper: { value: 0.9, unit: 'mg' },
    selenium: { value: 55, unit: 'mcg' },
  };
  const dv = dailyValues[nutrientKey];
  if (!dv || dv.unit !== unit) return null;
  return (value / dv.value) * 100;
};

export const getFoodPropertyBadges = (properties) => {
  if (!properties) return [];
  const badges = [];
  if (properties.fodmap) badges.push({ key: 'fodmap', text: properties.fodmap === 'high' ? 'High FODMAP' : 'Low FODMAP', type: properties.fodmap === 'high' ? 'warning' : 'success', icon: properties.fodmap === 'high' ? '⚠️' : '✓' });
  if (properties.histamine === 'low') badges.push({ key: 'histamine', text: 'Low Histamine', type: 'info', icon: '✓' });
  if (properties.safeForMCAS) badges.push({ key: 'mcas', text: 'MCAS Safe', type: 'success', icon: '✓' });
  if (properties.dairyFree) badges.push({ key: 'dairy', text: 'Dairy Free', type: 'info', icon: '🌱' });
  if (properties.glutenFree) badges.push({ key: 'gluten', text: 'Gluten Free', type: 'info', icon: '🌾' });
  if (properties.nightshade) badges.push({ key: 'nightshade', text: 'Nightshade', type: 'warning', icon: '🌶️' });
  return badges;
};

export const isNewFormat = (foodData) =>
  !!(foodData && foodData.nutrients && foodData.nutrients.per100g &&
    (getRecommendedServings(foodData).length > 0 ||
     getHealthBenefits(foodData).length > 0 ||
     getHealthRelevance(foodData)));

export const ensureCompatibleFormat = (foodData) =>
  isNewFormat(foodData) ? convertToLegacyFormat(foodData) : foodData;

// Default export for convenience
const healthDataAdapter = {
  // New generic accessors
  getHealthBenefits,
  getHealthCautions,
  getRecommendedServings,
  getHealthRelevance,
  detectConditionStatus,
  getParsedRecommendedServings,
  // Legacy aliases (safe to use — they call the new functions)
  getParsedLongCovidServings,
  // Core utilities
  parseServingAmount,
  scaleNutrient,
  scaleAllNutrients,
  convertToLegacyFormat,
  getMacrosForServing,
  getMicronutrientsForServing,
  formatNutrientValue,
  calculateDailyValuePercentage,
  getFoodPropertyBadges,
  isNewFormat,
  ensureCompatibleFormat,
};

export default healthDataAdapter;
