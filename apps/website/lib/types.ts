// Contratos de la API del ERP (/channel/hotel/*) tal como los consume el sitio.

export type HotelCatalog = {
  hotel: { name: string; email: string | null; phone: string | null; address: string | null };
  bookingEnabled: boolean;
  currency: 'DOP';
  taxRate: number;
  checkInTime: string;
  checkOutTime: string;
  maxStayNights: number;
  bookingWindowDays: number;
  today: string;
  roomTypes: RoomType[];
};

export type RoomType = {
  id: string;
  name: string;
  description: string | null;
  capacityAdults: number;
  capacityChildren: number;
  nightlyRate: number;
  amenities: string[];
  sellable: boolean;
};

export type Quote = {
  nightlyRate: number;
  nights: number;
  subtotal: number;
  taxRate: number;
  taxes: number;
  total: number;
};

export type StayAvailability = {
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  roomTypes: {
    roomTypeId: string;
    available: number;
    fitsGuests: boolean;
    bookable: boolean;
    soldOutDates: string[];
    quote: Quote;
  }[];
};

export type AvailabilityCalendar = {
  from: string;
  days: number;
  roomTypes: { roomTypeId: string; available: number[] }[];
};

export type ReservationRequest = {
  reference: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  firstName: string;
  lastName: string;
  documentType: 'CEDULA' | 'PASSPORT';
  documentNumber: string;
  phone: string;
  notes?: string;
  paymentMethod: 'CARD';
  cardLast4?: string;
  cardBrand?: string;
};

export type ReservationConfirmation = {
  duplicate: boolean;
  code: string;
  status: string;
  paymentStatus: string;
  paidAmount: number;
  roomType: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  total: number;
  currency: 'DOP';
};

export type ApiError = { message: string; code?: string };
