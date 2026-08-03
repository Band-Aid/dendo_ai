#!/usr/bin/env python3
"""Lookup Pendo feature and page names by ID using the REST API."""
import os
import sys
import json
import requests
from typing import Dict, List, Optional

def get_api_key() -> str:
    """Get Pendo API key from environment."""
    api_key = os.environ.get('PENDO_API_KEY') or os.environ.get('PENDO_INTEGRATION_KEY')
    if not api_key:
        raise ValueError("PENDO_API_KEY or PENDO_INTEGRATION_KEY environment variable not set")
    return api_key

def lookup_features(feature_ids: List[str], app_id: Optional[str] = None) -> Dict[str, str]:
    """Lookup feature names by IDs.
    
    Args:
        feature_ids: List of feature IDs to lookup
        app_id: Optional app ID filter
        
    Returns:
        Dict mapping feature ID to feature name
    """
    if not feature_ids:
        return {}
    
    api_key = get_api_key()
    # expand=* returns features across ALL apps — without it, multi-app
    # subscriptions only get the default app's features and every other
    # app's IDs fall through to the id-as-name fallback below.
    url = "https://app.pendo.io/api/v1/feature?expand=*"
    headers = {"x-pendo-integration-key": api_key}

    # Fetch all features (Pendo API doesn't support bulk ID lookup)
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    
    features = response.json()
    
    # Build ID to name mapping
    id_to_name = {}
    for feature in features:
        fid = feature.get('id')
        if fid in feature_ids:
            id_to_name[fid] = feature.get('name', fid)
    
    # For any IDs not found, use the ID itself
    for fid in feature_ids:
        if fid not in id_to_name:
            id_to_name[fid] = fid
    
    return id_to_name

def lookup_pages(page_ids: List[str], app_id: Optional[str] = None) -> Dict[str, str]:
    """Lookup page names by IDs.
    
    Args:
        page_ids: List of page IDs to lookup
        app_id: Optional app ID filter
        
    Returns:
        Dict mapping page ID to page name
    """
    if not page_ids:
        return {}
    
    api_key = get_api_key()
    # expand=* — same multi-app reasoning as lookup_features.
    url = "https://app.pendo.io/api/v1/page?expand=*"
    headers = {"x-pendo-integration-key": api_key}

    # Fetch all pages
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    
    pages = response.json()
    
    # Build ID to name mapping
    id_to_name = {}
    for page in pages:
        pid = page.get('id')
        if pid in page_ids:
            id_to_name[pid] = page.get('name', pid)
    
    # For any IDs not found, use the ID itself
    for pid in page_ids:
        if pid not in id_to_name:
            id_to_name[pid] = pid
    
    return id_to_name

def enrich_aggregation_results(data: dict) -> dict:
    """Automatically enrich aggregation results with feature and page names.
    
    Args:
        data: Aggregation result dict
        
    Returns:
        Enriched data with featureName and pageName fields added
    """
    # Extract all feature IDs and page IDs from results
    feature_ids = set()
    page_ids = set()
    
    def extract_ids(obj, path=''):
        """Recursively extract feature and page IDs."""
        if isinstance(obj, dict):
            for key, value in obj.items():
                if key in ['featureId', 'feature_id', 'feature']:
                    if value:
                        feature_ids.add(str(value))
                elif key in ['pageId', 'page_id', 'page']:
                    if value:
                        page_ids.add(str(value))
                else:
                    extract_ids(value, f"{path}.{key}")
        elif isinstance(obj, list):
            for item in obj:
                extract_ids(item, f"{path}[]")
    
    extract_ids(data)
    
    # Lookup names
    feature_names = {}
    page_names = {}
    
    try:
        if feature_ids:
            feature_names = lookup_features(list(feature_ids))
        if page_ids:
            page_names = lookup_pages(list(page_ids))
    except Exception as e:
        print(f"Warning: Failed to lookup names: {e}", file=sys.stderr)
    
    # Add names to results
    def add_names(obj):
        """Recursively add name fields next to ID fields."""
        if isinstance(obj, dict):
            new_obj = {}
            for key, value in obj.items():
                new_obj[key] = add_names(value)
                
                # Add featureName after featureId
                if key in ['featureId', 'feature_id', 'feature'] and value:
                    feature_id = str(value)
                    if feature_id in feature_names:
                        name_key = 'featureName' if key == 'featureId' else key.replace('Id', 'Name').replace('_id', '_name')
                        new_obj[name_key] = feature_names[feature_id]
                
                # Add pageName after pageId
                elif key in ['pageId', 'page_id', 'page'] and value:
                    page_id = str(value)
                    if page_id in page_names:
                        name_key = 'pageName' if key == 'pageId' else key.replace('Id', 'Name').replace('_id', '_name')
                        new_obj[name_key] = page_names[page_id]
            
            return new_obj
        elif isinstance(obj, list):
            return [add_names(item) for item in obj]
        else:
            return obj
    
    return add_names(data)

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] in ['-h', '--help']:
        print("Usage: python lookup_names.py <aggregation_result.json>")
        print("\nEnriches aggregation results with feature and page names.")
        print("\nExample:")
        print("  python -m tools.pendo.run_agg query.dsl | python lookup_names.py -")
        sys.exit(0)
    
    # Read JSON from file or stdin
    if sys.argv[1] == '-':
        data = json.load(sys.stdin)
    else:
        with open(sys.argv[1], 'r') as f:
            data = json.load(f)
    
    # Enrich and output
    enriched = enrich_aggregation_results(data)
    print(json.dumps(enriched, indent=2))
