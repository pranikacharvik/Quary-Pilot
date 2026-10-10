import { SAMPLE_SYNTHETIC_CSV } from './sampleSyntheticCsv';

export interface DatasetPreset {
  id: string;
  name: string;
  description: string;
  csvContent: string;
  rowCount: number;
}

export const ENTERPRISE_AUDIT_CSV = `search_term,campaign,ad_group,match_type,impressions,clicks,cost,conversions,conversion_value
enterprise cloud backup software,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Phrase,920,65,117.00,14,4200.00
automated soc2 compliance platform,SYNTHETIC_B2B_Security_Suite,SOC2_Automation,Exact,780,55,104.50,12,3600.00
b2b saas security audit tool,SYNTHETIC_B2B_Security_Suite,Security_Audit,Broad,1150,80,152.00,15,4500.00
free open source backup script tutorial,SYNTHETIC_B2B_Cloud_Backup,Cloud_Backup_Broad,Broad,2400,110,165.00,0,0.00
what is cloud computing definition pdf,SYNTHETIC_B2B_Cloud_Backup,Cloud_Backup_Broad,Broad,2100,95,142.50,0,0.00
cheap student laptop jobs remote,SYNTHETIC_B2B_Security_Suite,Security_General,Broad,1890,85,127.50,0,0.00
cloud backup enterprise pricing,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Phrase,35,2,3.80,1,300.00
enterprise backup compliance checklist,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Broad,210,15,27.00,1,300.00
multi cloud disaster recovery plan,SYNTHETIC_B2B_Cloud_Backup,Disaster_Recovery,Phrase,640,48,86.40,9.4,2820.00
hybrid cloud storage calculator,SYNTHETIC_B2B_Cloud_Backup,Cloud_Backup_Broad,Broad,290,18,28.80,1.6,480.00
enterprise disaster recovery template,SYNTHETIC_B2B_Cloud_Backup,Disaster_Recovery,Exact,140,0,0.00,0,0.00
zero click billed impression anomaly,SYNTHETIC_B2B_Security_Suite,Security_General,Broad,85,0,4.50,0,0.00
legacy tape backup migration,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Phrase,60,4,8.00,6,1800.00
cloud server backup solution,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Phrase,850,60,108.00,3,900.00
cloud server backup solution,SYNTHETIC_B2B_Cloud_Backup,Cloud_Backup_Broad,Broad,710,45,76.50,2,600.00
iso 27001 compliance software,SYNTHETIC_B2B_Security_Suite,SOC2_Automation,Phrase,680,50,95.00,3,900.00
iso 27001 compliance software,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Broad,420,30,54.00,1,300.00
managed database backup service,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Exact,910,70,126.00,4,1200.00
ransomware immutable backup storage,SYNTHETIC_B2B_Cloud_Backup,Disaster_Recovery,Phrase,760,55,99.00,3,900.00
continuous compliance monitoring tool,SYNTHETIC_B2B_Security_Suite,SOC2_Automation,Exact,830,62,117.80,3,900.00
vendor risk management questionnaire,SYNTHETIC_B2B_Security_Suite,Security_Audit,Phrase,610,44,83.60,2,600.00
kubernetes cluster backup tool,SYNTHETIC_B2B_Cloud_Backup,Disaster_Recovery,Broad,520,38,64.60,2,600.00
cloud security posture management,SYNTHETIC_B2B_Security_Suite,Security_Audit,Phrase,740,52,98.80,3,900.00
unattributed telemetry row missing conv,SYNTHETIC_B2B_Security_Suite,Security_General,Broad,190,14,22.40,,0.00
aws azure hybrid migration architecture,NA_Cloud_Core,Enterprise_Cloud_Migration,Exact,1420,118,245.00,22,6600.00
zero trust network architecture enterprise,Enterprise_Security_Postures,Zero_Trust_Core,Exact,980,72,168.00,14,4200.00
download crack cloud backup zip,SYNTHETIC_B2B_Cloud_Backup,Cloud_Backup_Broad,Broad,1560,94,141.00,0,0.00
salary ranges cloud security engineer 2026,Enterprise_Security_Postures,Security_General,Broad,2200,105,157.50,0,0.00
hipaa compliant cloud storage b2b,SYNTHETIC_B2B_Cloud_Backup,Healthcare_Compliance,Exact,640,46,115.00,9,2700.00
finops cloud cost management tool,NA_Cloud_Core,FinOps_Cost_Optimization,Phrase,890,62,130.20,11,3300.00
free aws credits promo code reddit,NA_Cloud_Core,Cloud_Backup_Broad,Broad,3100,142,213.00,0,0.00
enterprise kubernetes backup policy,SYNTHETIC_B2B_Cloud_Backup,Disaster_Recovery,Phrase,420,31,62.00,6,1800.00
cloud disaster recovery sla benchmarks,SYNTHETIC_B2B_Cloud_Backup,Disaster_Recovery,Exact,310,22,44.00,4,1200.00
fedramp moderate cloud backup service,SYNTHETIC_B2B_Cloud_Backup,Government_Compliance,Exact,520,38,95.00,7,2100.00
what does cloud backup cost per terabyte,SYNTHETIC_B2B_Cloud_Backup,Cloud_Backup_Broad,Phrase,780,48,72.00,2,600.00
how to backup postgres database on s3 script,SYNTHETIC_B2B_Cloud_Backup,Cloud_Backup_Broad,Broad,1840,88,132.00,0,0.00
automated penetration testing for saas,SYNTHETIC_B2B_Security_Suite,Security_Audit,Phrase,670,49,102.90,8,2400.00
pci dss compliance automation software,SYNTHETIC_B2B_Security_Suite,SOC2_Automation,Exact,850,58,127.60,10,3000.00
free vpn proxy extension chrome,SYNTHETIC_B2B_Security_Suite,Security_General,Broad,2950,135,189.00,0,0.00
cybersecurity internships summer college,SYNTHETIC_B2B_Security_Suite,Security_General,Broad,1450,68,95.20,0,0.00
enterprise identity threat detection,Enterprise_Security_Postures,Identity_Governance,Exact,720,54,124.20,11,3300.00
active directory disaster recovery azure,SYNTHETIC_B2B_Cloud_Backup,Disaster_Recovery,Phrase,460,34,71.40,5,1500.00
vmware to aws migration cost calculator,NA_Cloud_Core,Enterprise_Cloud_Migration,Phrase,590,41,86.10,6,1800.00
gcp multi region disaster recovery setup,SYNTHETIC_B2B_Cloud_Backup,Disaster_Recovery,Exact,380,26,57.20,4,1200.00
saas data protection backup solution,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Phrase,810,59,106.20,8,2400.00
cloud data residency compliance checklist,SYNTHETIC_B2B_Security_Suite,SOC2_Automation,Broad,340,24,43.20,1,300.00
unattended server backup powershell script,SYNTHETIC_B2B_Cloud_Backup,Cloud_Backup_Broad,Broad,990,52,78.00,0,0.00
database point in time recovery enterprise,SYNTHETIC_B2B_Cloud_Backup,Disaster_Recovery,Exact,610,45,94.50,7,2100.00
continuous audit readiness platform,SYNTHETIC_B2B_Security_Suite,SOC2_Automation,Phrase,510,36,79.20,6,1800.00
cloud security risk register template excel,SYNTHETIC_B2B_Security_Suite,Security_Audit,Broad,1120,60,84.00,0,0.00`;

export const TWO_CLICK_TRAP_CSV = `search_term,campaign,ad_group,match_type,impressions,clicks,cost,conversions,conversion_value
cloud backup enterprise pricing,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Phrase,35,2,3.80,1,300.00
enterprise backup compliance checklist,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Broad,210,15,27.00,1,300.00
enterprise cloud backup software,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Phrase,920,65,117.00,14,4200.00
managed database backup service,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Exact,910,70,126.00,4,1200.00
cloud server backup solution,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Phrase,850,60,108.00,3,900.00
legacy tape backup migration,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Phrase,60,4,8.00,6,1800.00
free open source backup script tutorial,SYNTHETIC_B2B_Cloud_Backup,Cloud_Backup_Broad,Broad,2400,110,165.00,0,0.00`;

export const COSTLY_WASTE_CSV = `search_term,campaign,ad_group,match_type,impressions,clicks,cost,conversions,conversion_value
free open source backup script tutorial,SYNTHETIC_B2B_Cloud_Backup,Cloud_Backup_Broad,Broad,2400,110,165.00,0,0.00
what is cloud computing definition pdf,SYNTHETIC_B2B_Cloud_Backup,Cloud_Backup_Broad,Broad,2100,95,142.50,0,0.00
cheap student laptop jobs remote,SYNTHETIC_B2B_Security_Suite,Security_General,Broad,1890,85,127.50,0,0.00
download crack cloud backup zip,SYNTHETIC_B2B_Cloud_Backup,Cloud_Backup_Broad,Broad,1560,94,141.00,0,0.00
free aws credits promo code reddit,NA_Cloud_Core,Cloud_Backup_Broad,Broad,3100,142,213.00,0,0.00
enterprise cloud backup software,SYNTHETIC_B2B_Cloud_Backup,Enterprise_Backup_Core,Phrase,920,65,117.00,14,4200.00
automated soc2 compliance platform,SYNTHETIC_B2B_Security_Suite,SOC2_Automation,Exact,780,55,104.50,12,3600.00`;

export const PRESET_DATASETS: DatasetPreset[] = [
  {
    id: 'enterprise_core',
    name: 'Enterprise Audit (50 Terms)',
    description: 'Comprehensive multi-campaign portfolio testing high-spend waste, winners, and baseline shrinkage.',
    csvContent: ENTERPRISE_AUDIT_CSV,
    rowCount: 50,
  },
  {
    id: 'synthetic_sample',
    name: 'Synthetic Hackathon Sample (24 Terms)',
    description: 'Official test benchmark covering B2B cloud backup and SOC2 security campaigns.',
    csvContent: SAMPLE_SYNTHETIC_CSV,
    rowCount: 24,
  },
  {
    id: 'two_click_trap',
    name: '2-Click Trap Defense (7 Terms)',
    description: 'Validates that small-sample queries with 50% CVR (2 clicks, 1 conv) are guarded and NOT promoted.',
    csvContent: TWO_CLICK_TRAP_CSV,
    rowCount: 7,
  },
  {
    id: 'costly_waste',
    name: 'CPA Floor Waste Bleeders (7 Terms)',
    description: 'Validates that high-spend queries exceeding account CPA with 0 conversions receive BLOCK recommendations.',
    csvContent: COSTLY_WASTE_CSV,
    rowCount: 7,
  },
];
