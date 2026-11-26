import {
  Bath,
  BedDouble,
  BedSingle,
  ChefHat,
  Coffee,
  DoorOpen,
  Lock,
  Snowflake,
  Sofa,
  Sparkles,
  Tv,
  Wifi,
  type LucideIcon,
} from 'lucide-react';

const amenityIcons: { match: RegExp; icon: LucideIcon }[] = [
  { match: /wi-?fi|internet/i, icon: Wifi },
  { match: /aire|a\/c|climat/i, icon: Snowflake },
  { match: /caja|safe/i, icon: Lock },
  { match: /tv|televis/i, icon: Tv },
  { match: /cocina|kitchen/i, icon: ChefHat },
  { match: /caf[eé]|coffee/i, icon: Coffee },
  { match: /baño|bath/i, icon: Bath },
  { match: /habitaciones|dormitorio|bedroom/i, icon: DoorOpen },
  { match: /sala|sof[aá]|comedor/i, icon: Sofa },
  { match: /2 camas|dos camas|twin/i, icon: BedSingle },
  { match: /cama|bed|king|queen|matrimonial/i, icon: BedDouble },
];

export const amenityIcon = (label: string) =>
  amenityIcons.find((rule) => rule.match.test(label))?.icon ?? Sparkles;
