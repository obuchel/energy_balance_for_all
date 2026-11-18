import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, getDocs, addDoc, deleteDoc, updateDoc, doc, getDoc, Timestamp, orderBy, limit, where } from 'firebase/firestore';
import { db } from '../../firebase-config';
import "../Common.css";
import './FoodTrackerPage.css';

import AddFoodTab from './AddFoodTab';
import FoodJournalTab from './FoodJournalTab';
import { AnalysisTab } from './FoodTrackerAnalysis';
import MicronutrientRadarChart from './MicronutrientRadarChart';
import VitaminTimeSeriesTab from './VitaminTimeSeriesTab';
import {
  ensureCompatibleFormat,
  getMacrosForServing,
  getMicronutrientsForServing,
  parseServingAmount,
  getHealthBenefits,
  getHealthCautions,
  getHealthRelevance,
  getRecommendedServings
} from './healthDataAdapter';
import foodSearchService from './foodSearchService';

const GRAMS_PER_OUNCE = 28.3495;

const convertWeight = {
  ozToG: (oz) => oz * GRAMS_PER_OUNCE,
  gToOz: (g) => g / GRAMS_PER_OUNCE,
};

// ─── Timezone utilities ────────────────────────────────────────────────────────

const getUserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const getTodayInUserTimezone = () => {
  const userTimezone = getUserTimezone();
  const today = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: userTimezone, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = formatter.formatToParts(today);
  const year  = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day   = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
};

const getDaysAgoInUserTimezone = (daysAgo) => {
  const userTimezone = getUserTimezone();
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: userTimezone, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
};

const parseLocalDate = (dateString) => {
  if (!dateString) return null;
  const parts = dateString.split('-');
  if (parts.length === 3) {
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  }
  return new Date(dateString);
};

const formatDateHeader = (dateString) => {
  if (!dateString) return '';
  try {
    const date = parseLocalDate(dateString);
    if (!date || isNaN(date.getTime())) return dateString;
    const today     = getTodayInUserTimezone();
    const yesterday = getDaysAgoInUserTimezone(1);
    const options   = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: getUserTimezone() };
    const formattedDate = date.toLocaleDateString('en-US', options);
    if (dateString === today)     return `Today - ${formattedDate}`;
    if (dateString === yesterday) return `Yesterday - ${formattedDate}`;
    return formattedDate;
  } catch (error) {
    console.warn('Error formatting date header:', error);
    return dateString;
  }
};

// ─── Constants ─────────────────────────────────────────────────────────────────

const mealTypes = ['Breakfast', 'Morning Snack', 'Lunch', 'Afternoon Snack', 'Dinner', 'Late Night Snack'];
const TABS = ['Add Food', 'Food Journal', 'Analysis', 'Trends'];
const ENTRIES_PER_PAGE = 20;
const ANALYSIS_DAYS = 180; // matches the longest range on the Trends tab ("Last 6 months")

// ─── Component ─────────────────────────────────────────────────────────────────

function FoodTrackerPage() {
  const navigate = useNavigate();

  const [searchFocused, setSearchFocused] = useState(false);
  const [searchServiceReady, setSearchServiceReady] = useState(false);
  const [searchServiceError, setSearchServiceError] = useState('');
  const [initProgress, setInitProgress] = useState('');

  const [currentUser, setCurrentUser] = useState(null);
  const [userProfile, setUserProfile] = useState({
    age: 30,
    gender: 'female',
    weight: 65,
    height: 165,
    activityLevel: 'moderate',
    // Generic condition fields (new)
    hasCondition: false,
    conditionSeverity: 'moderate',
    // Legacy Long COVID fields — kept for backward compat with FoodTrackerAnalysis
    hasLongCovid: false,
    longCovidSeverity: 'moderate'
  });
  const [authLoading, setAuthLoading] = useState(true);

  const [tab, setTab] = useState('Add Food');

  const [search, setSearch] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [selectedMeal, setSelectedMeal] = useState(null);
  const [fields, setFields] = useState({});
  const [mealType, setMealType] = useState('Breakfast');
  const [time, setTime] = useState(() => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const [date, setDate] = useState(() => getTodayInUserTimezone());
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const [foodLog, setFoodLog] = useState([]);
  // Date-range log for the Analysis and Trends tabs (independent of Journal paging)
  const [analysisLog, setAnalysisLog] = useState([]);
  const [logLoading, setLogLoading] = useState(false);
  const [journalError, setJournalError] = useState('');
  const [journalPage, setJournalPage] = useState(1);

  const [editingEntry, setEditingEntry] = useState(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const [suggestionCache, setSuggestionCache] = useState({});

  // ── Debounce ──────────────────────────────────────────────────────────────────
  const useDebounce = (value, delay) => {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
      const handler = setTimeout(() => setDebouncedValue(value), delay);
      return () => clearTimeout(handler);
    }, [value, delay]);
    return debouncedValue;
  };
  const debouncedSearch = useDebounce(search, 300);

  // ── Search service init ───────────────────────────────────────────────────────
  useEffect(() => {
    const initSearch = async () => {
      try {
        setInitProgress('Loading food database...');
        // Empty basePath so the fetch goes to /foods_updated.json at the domain root.
        // The GitHub Pages deploy serves it at the correct URL from the /public folder.
        const basePath = "";
        //const dataUrl = `${basePath}/foods_updated.json`;
        const dataUrl = `${import.meta.env.BASE_URL}foods_updated.json`;
        await foodSearchService.initialize(dataUrl);
        setSearchServiceReady(true);
        setInitProgress('');
        console.log('✅ Search service ready!');
      } catch (error) {
        console.error('Failed to initialize search:', error);
        setSearchServiceError('Failed to load food database. Please refresh the page.');
        setInitProgress('');
      }
    };
    initSearch();
    return () => foodSearchService.terminate();
  }, []);

  // ── Auth / logout ─────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    try {
      localStorage.removeItem('userData');
      sessionStorage.clear();
      setCurrentUser(null);
      setAuthLoading(false);
      navigate('/login', { replace: true });
    } catch (error) {
      localStorage.removeItem('userData');
      sessionStorage.clear();
      setCurrentUser(null);
      navigate('/login', { replace: true });
    }
  };

  // ── Delete entry ──────────────────────────────────────────────────────────────
  const handleDeleteEntry = async (entryId) => {
    if (!currentUser || !entryId) return;
    setDeleteLoading(true);
    setJournalError('');
    try {
      await deleteDoc(doc(db, 'users', currentUser.id, 'food_journal', entryId));
      setFoodLog(prevLog => prevLog.filter(entry => entry.id !== entryId));
      setAnalysisLog(prevLog => prevLog.filter(entry => entry.id !== entryId));
      setSuccess('Food entry deleted successfully!');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      console.error('Error deleting entry:', err);
      setJournalError(`Failed to delete entry: ${err.message}`);
    } finally {
      setDeleteLoading(false);
      setDeleteConfirmId(null);
    }
  };

  // ── Edit entry ────────────────────────────────────────────────────────────────
  const handleEditEntry = (entry) => {
    const userUnitSystem = userProfile?.unitSystem || 'metric';
    let displayServing = entry.serving || 0;
    let displayUnit = 'g';
    if (userUnitSystem === 'imperial') {
      displayServing = Math.round(convertWeight.gToOz(displayServing) * 10) / 10;
      displayUnit = 'oz';
    }

    const findAndSetMeal = async () => {
      try {
        const results = await foodSearchService.search(entry.name, 10);
        const meal = results.find(m => m.name === entry.name) || results[0];
        if (meal) {
          const compatibleMeal = ensureCompatibleFormat(meal);
          setSelectedMeal(compatibleMeal);
          setFields({
            name: entry.name,
            protein: entry.protein,
            carbs: entry.carbs,
            fat: entry.fat,
            calories: entry.calories,
            serving: displayServing,
            servingUnit: displayUnit,
            servingInGrams: entry.serving,
            servingDescription: entry.servingDescription,
            visualEquivalent: entry.visualEquivalent,
            servingReason: entry.servingReason,
            servingTiming: entry.servingTiming,
            micronutrients: entry.micronutrients || {},
            // Use adapter accessors — reads both new and legacy field names
            healthBenefits: getHealthBenefits(entry),
            healthCautions: getHealthCautions(entry),
            healthRelevance: getHealthRelevance(entry),
            // Keep legacy fields for backward compat with FoodTrackerAnalysis
            longCovidBenefits: getHealthBenefits(entry),
            longCovidCautions: getHealthCautions(entry),
            longCovidRelevance: getHealthRelevance(entry),
          });
        }
      } catch (err) {
        console.error('Error finding meal for edit:', err);
      }
    };

    findAndSetMeal();
    setSearch(entry.name);
    setMealType(entry.mealType);
    setTime(entry.time);
    setDate(entry.date);
    setEditingEntry(entry);
    setTab('Add Food');
  };

  // ── Log food ──────────────────────────────────────────────────────────────────
  const handleLogFood = async () => {
    if (!currentUser || !currentUser.id) { setError('Please log in to save your meals'); return; }
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      if (!fields.name) throw new Error('Food name is required');

      let servingInGrams = parseFloat(fields.serving) || 100;
      const servingUnit = fields.servingUnit || 'g';
      if (servingUnit === 'oz') {
        servingInGrams = convertWeight.ozToG(servingInGrams);
      }

      const entryData = {
        name: fields.name,
        protein: parseFloat(fields.protein) || 0,
        carbs: parseFloat(fields.carbs) || 0,
        fat: parseFloat(fields.fat) || 0,
        calories: parseFloat(fields.calories) || 0,
        serving: Math.round(servingInGrams * 10) / 10,
        servingUnit: 'g',
        servingDisplayed: fields.serving,
        servingDisplayedUnit: servingUnit,
        servingDescription: fields.servingDescription || null,
        visualEquivalent: fields.visualEquivalent || null,
        servingReason: fields.servingReason || null,
        servingTiming: fields.servingTiming || null,
        micronutrients: fields.micronutrients || {},
        mealType,
        time,
        date,
        // Store under both new and legacy names for full compatibility
        healthBenefits: getHealthBenefits(fields),
        healthCautions: getHealthCautions(fields),
        healthRelevance: getHealthRelevance(fields),
        longCovidBenefits: getHealthBenefits(fields),
        longCovidCautions: getHealthCautions(fields),
        longCovidRelevance: getHealthRelevance(fields),
        mealId: selectedMeal?.id || null
      };

      entryData.metabolicEfficiency = calculateMetabolicEfficiency(entryData);

      if (editingEntry) {
        await updateDoc(
          doc(db, 'users', currentUser.id, 'food_journal', editingEntry.id),
          { ...entryData, updatedAt: Timestamp.now() }
        );
        setFoodLog(prevLog =>
          prevLog.map(entry =>
            entry.id === editingEntry.id ? { ...entry, ...entryData, id: editingEntry.id } : entry
          )
        );
        fetchAnalysisLog();
        setSuccess('Food entry updated successfully!');
        setEditingEntry(null);
      } else {
        entryData.createdAt = Timestamp.now();
        const docRef = await addDoc(collection(db, 'users', currentUser.id, 'food_journal'), entryData);
        setFoodLog(prevLog => [{ id: docRef.id, ...entryData }, ...prevLog]);
        fetchAnalysisLog();
        setSuccess('Food logged successfully!');
      }

      setFields({});
      setSelectedMeal(null);
      setSearch('');
    } catch (err) {
      console.error('Error logging food:', err);
      setError(`Failed to ${editingEntry ? 'update' : 'log'} food: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingEntry(null);
    setFields({});
    setSelectedMeal(null);
    setSearch('');
    setSuccess('');
    setError('');
  };

  // ── User profile ──────────────────────────────────────────────────────────────
  const fetchUserProfile = useCallback(async (uid) => {
    try {
      const userDocRef = doc(db, 'users', uid);
      const userDoc = await getDoc(userDocRef);
      if (userDoc.exists()) {
        setUserProfile(userDoc.data());
      } else {
        setUserProfile(null);
      }
    } catch (err) {
      console.error('Error fetching user profile:', err);
      setError('Failed to load user profile');
      setUserProfile(null);
    }
  }, []);

  const checkUserAuthentication = useCallback(async () => {
    try {
      const storedUserData = localStorage.getItem('userData');
      if (!storedUserData) { navigate('/login'); return; }
      const parsedUserData = JSON.parse(storedUserData);
      setCurrentUser(parsedUserData);
      if (parsedUserData.id) await fetchUserProfile(parsedUserData.id);
      else setUserProfile(null);
    } catch (error) {
      console.error('Error checking authentication:', error);
      navigate('/login');
    } finally {
      setAuthLoading(false);
    }
  }, [navigate, fetchUserProfile]);

  useEffect(() => { checkUserAuthentication(); }, [checkUserAuthentication]);

  // ── Food health rating (generic, works for all users) ────────────────────────
  const getFoodHealthRating = (foodName) => {
    const foodLower = foodName.toLowerCase();
    const beneficial = [
      'salmon', 'mackerel', 'sardines', 'tuna', 'trout',
      'blueberries', 'strawberries', 'raspberries', 'blackberries',
      'spinach', 'kale', 'broccoli', 'brussels sprouts',
      'walnuts', 'almonds', 'chia seeds', 'flax seeds',
      'turmeric', 'ginger', 'garlic', 'onion',
      'olive oil', 'avocado', 'sweet potato',
      'green tea', 'dark chocolate'
    ];
    const caution = [
      'processed meat', 'bacon', 'sausage', 'hot dog',
      'french fries', 'fried chicken', 'fried',
      'white bread', 'white rice', 'pastry',
      'candy', 'soda', 'sugar', 'margarine',
      'ice cream', 'chips'
    ];
    if (beneficial.some(food => foodLower.includes(food))) return 'beneficial';
    if (caution.some(food => foodLower.includes(food))) return 'caution';
    return 'neutral';
  };

  // ── Utilities ─────────────────────────────────────────────────────────────────
  const convertTo24Hour = (time12h) => {
    if (!time12h) return '';
    const [time, modifier] = time12h.split(' ');
    if (!time || !modifier) return time12h;
    let [hours, minutes] = time.split(':');
    if (hours === '12') hours = '00';
    if (modifier === 'PM') hours = String(parseInt(hours, 10) + 12);
    return `${String(hours).padStart(2, '0')}:${minutes}`;
  };

  const handleTimeChange = (e) => {
    const time24 = e.target.value;
    if (!time24) return;
    const d = new Date(`2000-01-01T${time24}`);
    setTime(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  };

  // ── Metabolic efficiency — works for all users; condition users get adjusted score ──
  const calculateMetabolicEfficiency = (mealData) => {
    const timeStr = mealData.time;
    const hourMatch = timeStr.match(/(\d+):/);
    const hour = hourMatch ? parseInt(hourMatch[1], 10) : 12;
    const isPM = timeStr.toLowerCase().includes('pm');
    let hour24 = hour;
    if (isPM && hour !== 12) hour24 += 12;
    if (!isPM && hour === 12) hour24 = 0;

    const proteinFactor = (parseFloat(mealData.protein) || 0) * 0.2;
    const carbFactor    = (parseFloat(mealData.carbs)   || 0) * 0.1;
    const fatFactor     = (parseFloat(mealData.fat)     || 0) * 0.15;

    let timeFactor = 1.0;
    if (hour24 < 6 || hour24 > 20) timeFactor = 0.7;
    else if (hour24 >= 7 && hour24 <= 10) timeFactor = 1.2;
    else if (hour24 >= 17 && hour24 <= 19) timeFactor = 0.9;

    const mealTypeFactors = {
      'Breakfast': 1.3, 'Morning Snack': 0.9, 'Lunch': 1.1,
      'Afternoon Snack': 0.8, 'Dinner': 0.9, 'Late Night Snack': 0.6, 'Snack': 0.8
    };
    const mealTypeFactor = mealTypeFactors[mealData.mealType] || 1.0;
    const macroBalance = Math.min(100, (proteinFactor + carbFactor + fatFactor) * 10);
    let efficiency = macroBalance * timeFactor * mealTypeFactor;

    // Apply condition adjustment — reads both new and legacy fields
    const hasCondition = userProfile?.hasCondition || userProfile?.hasLongCovid;
    if (hasCondition) {
      const severityFactors = { 'mild': 0.95, 'moderate': 0.85, 'severe': 0.75, 'very severe': 0.65 };
      const severity = userProfile?.conditionSeverity || userProfile?.longCovidSeverity || 'moderate';
      efficiency *= severityFactors[severity] || 0.85;

      if (getHealthBenefits(mealData).length > 0) efficiency *= 1.1;
      if (getHealthCautions(mealData).length > 0) efficiency *= 0.9;
    }

    return Math.min(100, Math.max(0, efficiency));
  };

  // ── Nutrient recalculation ────────────────────────────────────────────────────
  const recalculateNutrients = useCallback((newServing, unit = 'g') => {
    if (!selectedMeal) return;
    const serving = parseFloat(newServing);
    if (isNaN(serving) || serving <= 0) return;

    const nutrients = selectedMeal.nutritional_metrics?.nutrients_per_100g ||
                      selectedMeal.nutrients?.per100g || {};
    let servingInGrams = serving;
    if (unit === 'oz') {
      servingInGrams = convertWeight.ozToG(serving);
    } else if (unit === 'ml') {
      const density = getDensityForFood(selectedMeal.name) || 1.0;
      servingInGrams = serving * density;
    }
    const ratio = servingInGrams / 100;

    setFields(prevFields => {
      const updatedFields = { ...prevFields, serving, servingUnit: unit, servingInGrams };
      if (nutrients.protein?.value !== undefined)  updatedFields.protein  = (nutrients.protein.value  * ratio).toFixed(1);
      if (nutrients.carbs?.value !== undefined)    updatedFields.carbs    = (nutrients.carbs.value    * ratio).toFixed(1);
      if (nutrients.fat?.value !== undefined)      updatedFields.fat      = (nutrients.fat.value      * ratio).toFixed(1);
      if (nutrients.calories?.value !== undefined) updatedFields.calories = (nutrients.calories.value * ratio).toFixed(0);

      updatedFields.micronutrients = {};
      Object.entries(nutrients).forEach(([key, value]) => {
        if (!['protein', 'carbs', 'fat', 'calories', 'name', 'unit'].includes(key) && value?.value !== undefined) {
          updatedFields.micronutrients[key] = { ...value, value: (value.value * ratio).toFixed(1) };
        }
      });
      return updatedFields;
    });
  }, [selectedMeal]);

  // ── Select meal ───────────────────────────────────────────────────────────────
  const handleSelectMeal = (meal) => {
    setSelectedMeal(meal);
    setSearch(meal.name);
    setSuggestions([]);
    setSearchFocused(false);

    let defaultServing = 100;
    let defaultUnit = 'g';
    let defaultDescription = '100g';

    // Use new generic accessor — reads recommendedServings OR legacy longCovidServings
    const recommended = getRecommendedServings(meal);
    if (recommended.length > 0) {
      const firstServing = recommended[1] || recommended[0];
      const parsed = parseServingAmount(firstServing.amount);
      defaultServing = parsed.weight;
      defaultUnit = parsed.unit;
      defaultDescription = firstServing.name;
    } else if (meal.nutritional_metrics?.serving_options) {
      const firstOption = Object.values(meal.nutritional_metrics.serving_options)[0];
      if (firstOption) {
        defaultServing = firstOption.weight;
        defaultUnit = firstOption.unit || 'g';
        defaultDescription = firstOption.description;
      }
    }

    const macros = getMacrosForServing(meal, defaultServing);
    const micronutrients = getMicronutrientsForServing(meal, defaultServing);

    setFields({
      name: meal.name,
      serving: defaultServing,
      servingUnit: defaultUnit,
      servingDescription: defaultDescription,
      calories:  Math.round(macros.calories),
      protein:   Number(macros.protein.toFixed(1)),
      carbs:     Number(macros.carbs.toFixed(1)),
      fat:       Number(macros.fat.toFixed(1)),
      fiber:     Number(macros.fiber.toFixed(1)),
      sugars:    Number(macros.sugars.toFixed(1)),
      micronutrients,
      // Store under both new and legacy names
      healthBenefits:    getHealthBenefits(meal),
      healthCautions:    getHealthCautions(meal),
      healthRelevance:   getHealthRelevance(meal),
      longCovidBenefits: getHealthBenefits(meal),
      longCovidCautions: getHealthCautions(meal),
      longCovidRelevance: getHealthRelevance(meal),
      functionalCompounds: meal.functionalCompounds || {},
      properties: meal.properties || {}
    });
  };

  // ── Serving selection ─────────────────────────────────────────────────────────
  const handleServingSelection = (weight, description, unit = 'g', visualEquivalent = null, reason = null, timing = null) => {
    if (!selectedMeal) return;
    let weightInGrams = weight;
    if (unit === 'oz') weightInGrams = convertWeight.ozToG(weight);

    const macros = getMacrosForServing(selectedMeal, weightInGrams);
    const micronutrients = getMicronutrientsForServing(selectedMeal, weightInGrams);

    setFields(prevFields => ({
      ...prevFields,
      serving: weight,
      servingUnit: unit,
      servingInGrams: weightInGrams,
      servingDescription: description,
      visualEquivalent,
      servingReason: reason,
      servingTiming: timing,
      calories:  Math.round(macros.calories),
      protein:   Number(macros.protein.toFixed(1)),
      carbs:     Number(macros.carbs.toFixed(1)),
      fat:       Number(macros.fat.toFixed(1)),
      fiber:     Number(macros.fiber.toFixed(1)),
      sugars:    Number(macros.sugars.toFixed(1)),
      micronutrients,
      // Preserve health metadata — don't overwrite on serving change
      healthBenefits:    prevFields.healthBenefits    || getHealthBenefits(selectedMeal),
      healthCautions:    prevFields.healthCautions    || getHealthCautions(selectedMeal),
      healthRelevance:   prevFields.healthRelevance   || getHealthRelevance(selectedMeal),
      longCovidBenefits: prevFields.longCovidBenefits || getHealthBenefits(selectedMeal),
      longCovidCautions: prevFields.longCovidCautions || getHealthCautions(selectedMeal),
      longCovidRelevance: prevFields.longCovidRelevance || getHealthRelevance(selectedMeal),
      functionalCompounds: prevFields.functionalCompounds || selectedMeal.functionalCompounds || {},
      properties: prevFields.properties || selectedMeal.properties || {}
    }));

    setSuccess(`Serving updated to ${description} (${weight}${unit})`);
    setTimeout(() => setSuccess(''), 2000);
  };

  const getDensityForFood = (foodName) => {
    if (!foodName || typeof foodName !== 'string') return 1.0;
    const foodLower = foodName.toLowerCase();
    const densityMap = {
      'water': 1.0, 'milk': 1.03, 'cream': 1.0, 'oil': 0.92, 'juice': 1.05,
      'soup': 1.0, 'broth': 1.0, 'stock': 1.0, 'coffee': 1.0, 'tea': 1.0,
      'wine': 0.99, 'beer': 1.0, 'yogurt': 1.1, 'smoothie': 1.1, 'sauce': 1.1,
      'syrup': 1.3, 'honey': 1.4
    };
    for (const [key, density] of Object.entries(densityMap)) {
      if (foodLower.includes(key)) return density;
    }
    return 1.0;
  };

  // ── Search ────────────────────────────────────────────────────────────────────
  const fetchSuggestions = useCallback(async () => {
    const normalizedSearch = search.toLowerCase().trim();
    if (normalizedSearch.length < 2) { setSuggestions([]); return; }
    if (suggestionCache[normalizedSearch]) { setSuggestions(suggestionCache[normalizedSearch]); return; }
    if (!searchServiceReady) return;

    try {
      const results = await foodSearchService.search(normalizedSearch, 100);
      const compatibleResults = results.map(food => ensureCompatibleFormat(food));
      setSuggestionCache(prev => ({ ...prev, [normalizedSearch]: compatibleResults }));
      setSuggestions(compatibleResults);
      setError('');
    } catch (err) {
      console.error('Search error:', err);
      setSuggestions([]);
      setError('Search failed. Please try again.');
    }
  }, [search, suggestionCache, searchServiceReady]);

  const clearSearch = () => {
    setSearch(''); setSuggestions([]); setSelectedMeal(null); setSearchFocused(false); setFields({});
  };

  const renderSearchInput = () => (
    <div className="form-group search-group">
      <label>Search Food</label>
      <div className={`search-input-container ${searchFocused ? 'search-focused' : ''}`}>
        <input
          type="text" value={search}
          onChange={e => {
            const newValue = e.target.value;
            setSearch(newValue);
            setSelectedMeal(null);
            if (newValue.length < 2) setSuggestions([]);
          }}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => { setTimeout(() => { setSearchFocused(false); setSuggestions([]); }, 200); }}
          placeholder="Search foods..."
          autoComplete="off"
          className="search-input"
        />
        {search.length > 0 && (
          <button onClick={clearSearch} className="clear-search-button" type="button" title="Clear search">✕</button>
        )}
        <div className="search-status">
          {suggestions.length > 0 && (
            <span className="result-count">
              {suggestions.length} result{suggestions.length !== 1 ? 's' : ''}
              {suggestions.length > 50 && <span className="large-result-hint"> - scroll to see more</span>}
            </span>
          )}
        </div>
      </div>

      {suggestions.length > 0 && searchFocused && (
        <div className="suggestions-container">
          <ul className="suggestions-list unlimited">
            {suggestions.map((s, index) => (
              <li key={s.id || index} onClick={() => handleSelectMeal(s)}
                onMouseDown={(e) => e.preventDefault()} className="suggestion-item">
                <div className="suggestion-main">
                  <div className="suggestion-name">{s.name}</div>
                  {s.category && <div className="suggestion-category">{s.category}</div>}
                  {s.searchScore && (
                    <div className="suggestion-score" title={`Relevance: ${s.searchScore}`}>
                      {s.searchScore >= 50 ? '🎯' : s.searchScore >= 20 ? '🔍' : '📄'}
                    </div>
                  )}
                </div>
                <div className="suggestion-indicators">
                  {s.nutritional_metrics?.serving_options && (
                    <span className="serving-indicator" title="Has serving suggestions">📏</span>
                  )}
                  <span className={`covid-indicator ${getFoodHealthRating(s.name)}`}>
                    {getFoodHealthRating(s.name) === 'beneficial' ? '✅' :
                     getFoodHealthRating(s.name) === 'caution' ? '⚠️' : 'ℹ️'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {suggestions.length > 20 && (
            <div className="search-tips">
              <small>💡 Tip: Type more specific terms to narrow down results, or scroll to browse all {suggestions.length} matches</small>
            </div>
          )}
        </div>
      )}
    </div>
  );

  useEffect(() => {
    if (debouncedSearch.length < 2) { setSuggestions([]); return; }
    fetchSuggestions();
  }, [debouncedSearch, fetchSuggestions]);

  const handleFieldChange = (e) => {
    const { name, value } = e.target;
    if (name === 'serving') {
      setFields(prev => ({ ...prev, [name]: value }));
      if (selectedMeal) recalculateNutrients(value, fields.servingUnit || 'g');
    } else {
      setFields(prev => ({ ...prev, [name]: value }));
    }
  };

  const handleUnitChange = (e) => {
    const newUnit = e.target.value;
    const currentServing = parseFloat(fields.serving) || 0;
    const oldUnit = fields.servingUnit || 'g';
    if (currentServing === 0 || newUnit === oldUnit) {
      setFields(prev => ({ ...prev, servingUnit: newUnit }));
      return;
    }
    let convertedServing = currentServing;
    if (oldUnit === 'g' && newUnit === 'oz') convertedServing = Math.round(convertWeight.gToOz(currentServing) * 10) / 10;
    else if (oldUnit === 'oz' && newUnit === 'g') convertedServing = Math.round(convertWeight.ozToG(currentServing));
    setFields(prev => ({ ...prev, serving: convertedServing, servingUnit: newUnit }));
    if (selectedMeal) recalculateNutrients(convertedServing, newUnit);
  };

  // ── Food log fetch ────────────────────────────────────────────────────────────
  const fetchFoodLog = useCallback(async (page = 1) => {
    if (!currentUser || !currentUser.id) return;
    setLogLoading(true);
    if (page === 1) setFoodLog([]);
    setJournalError('');
    try {
      const q = query(
        collection(db, 'users', currentUser.id, 'food_journal'),
        orderBy('date', 'desc'), orderBy('createdAt', 'desc'),
        limit(ENTRIES_PER_PAGE * page)
      );
      const snap = await getDocs(q);
      setFoodLog(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      setJournalPage(page);
    } catch (err) {
      console.error('Error fetching food log:', err);
      setJournalError(`Failed to load journal: ${err.message}`);
    } finally {
      setLogLoading(false);
    }
  }, [currentUser]);

  useEffect(() => {
    if (currentUser && !authLoading) fetchFoodLog(1);
  }, [currentUser, authLoading, fetchFoodLog]);

  // Analysis / Trends data: everything from the last ANALYSIS_DAYS days, newest first.
  // Uses the same (date desc, createdAt desc) ordering as the journal query, so it needs no new index.
  const fetchAnalysisLog = useCallback(async () => {
    if (!currentUser || !currentUser.id) return;
    try {
      const q = query(
        collection(db, 'users', currentUser.id, 'food_journal'),
        where('date', '>=', getDaysAgoInUserTimezone(ANALYSIS_DAYS)),
        orderBy('date', 'desc'), orderBy('createdAt', 'desc')
      );
      const snap = await getDocs(q);
      setAnalysisLog(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('Error fetching analysis log:', err);
      // Fall back to whatever the journal has loaded so the tabs still show something
      setAnalysisLog([]);
    }
  }, [currentUser]);

  useEffect(() => {
    if (currentUser && !authLoading) fetchAnalysisLog();
  }, [currentUser, authLoading, fetchAnalysisLog]);

  const handleBack = () => navigate('/dashboard');

  // ── Loading / auth guards ─────────────────────────────────────────────────────
  if (!searchServiceReady && !searchServiceError) {
    return (
      <div className="food-tracker-container">
        <div className="loading-indicator">
          <div className="spinner"></div>
          <h3>🔍 Loading Food Database...</h3>
          {initProgress && <p className="init-progress">{initProgress}</p>}
          <p className="loading-tip">💡 This is a one-time load for your session.<br />Future visits will load from cache instantly!</p>
          <div className="loading-details"><small>Loading 50MB+ database with 8,000+ foods...</small></div>
        </div>
      </div>
    );
  }

  if (searchServiceError) {
    return (
      <div className="food-tracker-container">
        <div className="error-indicator">
          <div className="error-icon">❌</div>
          <h3>{searchServiceError}</h3>
          <p>Please check your internet connection and try again.</p>
          <button onClick={() => window.location.reload()} className="retry-button">Retry</button>
          <button onClick={handleBack} className="btn-primary">Return to Dashboard</button>
        </div>
      </div>
    );
  }

  if (authLoading) {
    return (
      <div className="food-tracker-container">
        <div className="loading-indicator"><div className="spinner"></div><h3>Loading...</h3></div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="food-tracker-container">
        <div className="auth-required">
          <h2>Authentication Required</h2>
          <p>Please log in to use the food tracker.</p>
          <button onClick={handleBack} className="back-button">Back to Dashboard</button>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="food-tracker-container">
      <div className="bg-animation">
        <div className="card-glow"></div>
        <div className="floating-shape shape-1"></div>
        <div className="floating-shape shape-2"></div>
        <div className="floating-shape shape-3"></div>
        <div className="floating-shape shape-4"></div>
        <div className="floating-shape shape-5"></div>
        <div className="floating-shape shape-6"></div>
      </div>

      <div className="food-tracker-content">
        <div className="tracker-header">
          <button onClick={handleBack} className="back-button">← Back to Dashboard</button>
          <button onClick={handleLogout} className="logout-btn">Logout</button>
        </div>

        <h2>🍽️ Smart Meal Tracker</h2>

        <div className="food-tabs">
          {TABS.map(t => (
            <button key={t} className={`food-tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>

        {tab === 'Add Food' && (
          <AddFoodTab
            search={search} setSearch={setSearch} suggestions={suggestions}
            selectedMeal={selectedMeal} fields={fields} mealType={mealType}
            setMealType={setMealType} time={time} date={date} setDate={setDate}
            renderSearchInput={renderSearchInput} editingEntry={editingEntry}
            handleCancelEdit={handleCancelEdit} handleFieldChange={handleFieldChange}
            handleServingSelection={handleServingSelection} handleUnitChange={handleUnitChange}
            handleTimeChange={handleTimeChange} convertTo24Hour={convertTo24Hour}
            handleLogFood={handleLogFood} loading={loading} success={success} error={error}
            mealTypes={mealTypes} foodLog={foodLog}
            MicronutrientRadarChart={MicronutrientRadarChart} userProfile={userProfile}
          />
        )}

        {tab === 'Food Journal' && (
          <FoodJournalTab
            foodLog={foodLog} journalPage={journalPage}
            logLoading={logLoading} journalError={journalError}
            success={success} deleteConfirmId={deleteConfirmId}
            setDeleteConfirmId={setDeleteConfirmId} deleteLoading={deleteLoading}
            handleDeleteEntry={handleDeleteEntry} fetchFoodLog={fetchFoodLog}
            handleEditEntry={handleEditEntry} ENTRIES_PER_PAGE={ENTRIES_PER_PAGE}
            formatDateHeader={formatDateHeader}
          />
        )}

        {tab === 'Analysis' && <AnalysisTab foodLog={analysisLog.length ? analysisLog : foodLog} userProfile={userProfile} />}

        {tab === 'Trends' && <VitaminTimeSeriesTab foodLog={analysisLog.length ? analysisLog : foodLog} userProfile={userProfile} />}
      </div>
    </div>
  );
}

export default FoodTrackerPage;
