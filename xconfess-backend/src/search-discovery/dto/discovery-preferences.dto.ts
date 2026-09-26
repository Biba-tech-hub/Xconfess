export class UpdateDiscoveryPreferencesDto {
  personalizationOptOut?: boolean;
  diversityThreshold?: number;
  excludedCategories?: string[];
}

export interface RecommendationExplanation {
  source: 'recent_interest' | 'global_trending' | 'diversity_fill' | 'cold_start';
  reason: string;
  category: string;
}

export interface RecommendedConfessionDto {
  id: string;
  title: string;
  category: string;
  reactionCount: number;
  gender?: string;
  createdAt: Date;
  explanation: RecommendationExplanation;
  isPersonalized: boolean;
}
