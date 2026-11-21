`timescale 1ns/1ps
module tb_uart_tx;
reg clk=0, reset_n=0, valid=0; reg [7:0] data=0;
always #5 clk=~clk;
wire tx,ready,busy;
integer i,j;
reg [7:0] values[0:3];
uart_tx #(.CLOCK_HZ(1600000),.BAUD(100000)) dut(clk,reset_n,data,valid,ready,tx,busy);
initial begin
 values[0]=0; values[1]=255; values[2]=170; values[3]=85;
 repeat(5) @(negedge clk); reset_n=1;
 for(j=0;j<4;j=j+1) begin
  wait(ready); @(negedge clk); data=values[j]; valid=1;
  @(negedge clk); valid=0;
  if(tx!==0 || !busy) $fatal(1,"FAIL TX start");
  repeat(8) @(negedge clk);
  for(i=0;i<8;i=i+1) begin
   repeat(16) @(negedge clk);
   if(tx!==values[j][i]) $fatal(1,"FAIL TX bit");
  end
  repeat(16) @(negedge clk); if(tx!==1) $fatal(1,"FAIL TX stop");
  wait(ready);
 end
 $display("PASS uart_tx framing and ready/busy"); $finish;
end
initial begin #100000; $fatal(1,"FAIL TX timeout"); end
endmodule
