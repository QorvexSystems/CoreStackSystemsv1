'use client';

import { useQuery } from '@tanstack/react-query';
import { Eye, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getEmployees } from '@/lib/api';
import { brand } from '@/lib/brand';
import { getStatusVariant, translateRole, translateStatus } from '@/lib/display-labels';
import { EmployeeFormDialog } from './employee-form-dialog';
import { ModuleHeader } from './module-header';
import { SessionRequired, useCurrentSession } from './session-required';

export function EmployeesView() {
  const session = useCurrentSession();
  const [newEmployeeOpen, setNewEmployeeOpen] = useState(false);
  const employeesQuery = useQuery({
    queryKey: ['employees', session?.tenantId],
    queryFn: () => getEmployees(session?.tenantId ?? '', session?.accessToken ?? ''),
    enabled: Boolean(session),
  });

  if (!session) {
    return <SessionRequired session={session} />;
  }

  return (
    <div className="space-y-6">
      <ModuleHeader
        title="Empleados"
        description={`Administra el equipo de ${brand.name}, sus accesos y estado laboral.`}
      />

      <div className="flex justify-end">
        <Button type="button" onClick={() => setNewEmployeeOpen(true)}>
          <Plus className="h-4 w-4" />
          Nuevo empleado
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Equipo {brand.name}</CardTitle>
          <CardDescription>
            {employeesQuery.data?.length ?? 0} perfiles laborales registrados.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Empleado</TableHead>
                  <TableHead>Rol</TableHead>
                  <TableHead>Permisos</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(employeesQuery.data ?? []).map((employee) => {
                  const membership = employee.user.memberships[0];
                  return (
                    <TableRow key={employee.id}>
                      <TableCell>
                        <div className="font-medium">{employee.user.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {employee.employeeCode ?? 'Sin codigo'} - {employee.user.email}
                        </div>
                      </TableCell>
                      <TableCell>{translateRole(membership?.role) ?? 'Sin rol'}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {membership?.role === 'ADMIN' ? (
                            <Badge variant="success">Acceso total</Badge>
                          ) : null}
                          {membership?.role === 'RECEPTION' ? (
                          <Badge variant="success">Recepción, reservaciones y cobros</Badge>
                          ) : null}
                          {membership?.role === 'HOUSEKEEPING' ? (
                            <Badge variant="success">Limpieza de habitaciones</Badge>
                          ) : null}
                          {membership?.role === 'ACCOUNTANT' ? (
                            <Badge variant="success">Contabilidad y reportes</Badge>
                          ) : null}
                          {membership?.role === 'CASHIER' ? (
                            <Badge variant="success">Caja y cobros</Badge>
                          ) : null}
                          {membership?.canUsePos ? (
                            <Badge variant="success">Usar caja</Badge>
                          ) : null}
                          {membership?.canTakeOrders ? (
                            <Badge variant="success">Tomar ordenes</Badge>
                          ) : null}
                          {membership?.canOpenCashSession ? (
                            <Badge variant="outline">Abrir caja</Badge>
                          ) : null}
                          {membership?.canCloseCashSession ? (
                            <Badge variant="outline">Cerrar caja</Badge>
                          ) : null}
                          {membership?.canApplyDiscount ? (
                            <Badge variant="outline">Descuentos</Badge>
                          ) : null}
                          {membership?.canCancelInvoice ? (
                            <Badge variant="outline">Cancelar facturas</Badge>
                          ) : null}
                          {membership?.canVoidInvoice ? (
                            <Badge variant="outline">Anular facturas</Badge>
                          ) : null}
                          {membership?.canManageProducts ? (
                            <Badge variant="outline">Productos</Badge>
                          ) : null}
                          {membership?.canAdjustInventory ? (
                            <Badge variant="outline">Inventario</Badge>
                          ) : null}
                          {membership?.canManageEmployees ? (
                            <Badge variant="outline">Empleados</Badge>
                          ) : null}
                          {membership?.canViewReports ? (
                            <Badge variant="outline">Reportes</Badge>
                          ) : null}
                          {membership?.canManageFiscalSequences ? (
                            <Badge variant="outline">Secuencias fiscales</Badge>
                          ) : null}
                          {membership?.canViewCashLogs ? (
                            <Badge variant="outline">Logs de caja</Badge>
                          ) : null}
                          {membership?.canReprintReceipt ? (
                            <Badge variant="outline">Reimprimir recibos</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={getStatusVariant(employee.status)}>
                          {translateStatus(employee.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button asChild variant="ghost" size="icon">
                            <Link href={`/employees/${employee.id}`} aria-label="Ver empleado">
                              <Eye className="h-4 w-4" />
                            </Link>
                          </Button>
                          <Button asChild variant="ghost" size="icon">
                            <Link
                              href={`/employees/${employee.id}/edit`}
                              aria-label="Editar empleado"
                            >
                              <Pencil className="h-4 w-4" />
                            </Link>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <EmployeeFormDialog
        open={newEmployeeOpen}
        onClose={() => setNewEmployeeOpen(false)}
        onSaved={() => setNewEmployeeOpen(false)}
      />
    </div>
  );
}
